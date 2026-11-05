import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: commands.run };
});

let root: string;
let entry: string;
let registry: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-autostart-check-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.stubEnv('OPENBUTLER_TEST_SECRET', 'must-not-be-in-launcher');
  entry = process.argv[1]!;
  process.argv[1] = join(root, 'OpenButler CLI', 'cli.js');
  registry = {};
  vi.resetModules();
  commands.run.mockReset();
  commands.run.mockImplementation((program: string, args: string[]) => {
    if (program !== 'reg.exe') throw new Error('Unexpected OS command in fixture.');
    const value = args[args.indexOf('/v') + 1]!;
    if (args[0] === 'query')
      return registry[value] === undefined
        ? { status: 1, stdout: '', stderr: 'Not found' }
        : { status: 0, stdout: `${value} REG_SZ ${registry[value]}`, stderr: '' };
    if (args[0] === 'add') {
      registry[value] = args[args.indexOf('/d') + 1]!;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'delete') {
      delete registry[value];
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected reg.exe verb in fixture: ${String(args[0])}`);
  });
});
afterEach(() => {
  process.argv[1] = entry;
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-autostart-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

const hostLauncher = (): string => join(root, 'autostart', 'openbutler-logon.vbs');
const webLauncher = (): string => join(root, 'autostart', 'openbutler-web-logon.vbs');

describe('login startup Telegram wiring (cross-platform builders)', () => {
  it('embeds the token inline in the macOS agent and escapes XML', async () => {
    const service = await import('../src/daemon-autostart.js');
    const document = service.buildMacosDocument('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/daemon.log', {
      TELEGRAM_BOT_TOKEN: '123:a&b<c>',
    });
    expect(document).toContain('<key>TELEGRAM_BOT_TOKEN</key><string>123:a&amp;b&lt;c&gt;</string>');
    expect(document).toContain('<key>OPENBUTLER_DATA_DIR</key>');
    const plain = service.buildMacosDocument('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/daemon.log', {});
    expect(plain).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(plain).toContain('<key>EnvironmentVariables</key><dict><key>OPENBUTLER_DATA_DIR</key><string>/data</string></dict>');
  });

  it('wires the token through an optional env file on Linux, never inline', async () => {
    const service = await import('../src/daemon-autostart.js');
    const wired = service.buildLinuxUnit('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/telegram.env');
    expect(wired).toContain('EnvironmentFile=-"/data/telegram.env"');
    expect(wired).not.toContain('123:');
    const plain = service.buildLinuxUnit('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', null);
    expect(plain).not.toContain('EnvironmentFile');
    expect(plain).toContain('Environment="OPENBUTLER_DATA_DIR=/data"');
  });

  it('keeps the host unit free of web and gives the browser client its own unit', async () => {
    const service = await import('../src/daemon-autostart.js');
    const host = service.buildLinuxUnit('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', null);
    expect(host).toContain('"daemon" "run"');
    expect(host).not.toContain('--web');
    expect(host).not.toContain('openbutler-web.service');

    const web = service.buildLinuxWebUnit(
      '/bin/openbutler',
      ['/app/cli.js', 'web', '--serve', '--port', '45278', '--hostname', '0.0.0.0', '--dir', '/work'],
      '/data',
    );
    expect(web).toContain('"web" "--serve" "--port" "45278" "--hostname" "0.0.0.0" "--dir" "/work"');
    expect(web).toContain('After=openbutler.service');
    expect(web).toContain('Wants=openbutler.service');
    expect(web).not.toContain('daemon"');
  });

  it('labels the macOS host and web agents independently', async () => {
    const service = await import('../src/daemon-autostart.js');
    const host = service.buildMacosDocument('/bin/openbutler', ['/app/cli.js', 'daemon', 'run'], '/data', '/data/daemon.log', {});
    const web = service.buildMacosDocument(
      '/bin/openbutler',
      ['/app/cli.js', 'web', '--serve'],
      '/data',
      '/data/daemon.log',
      {},
      undefined,
      'ai.openbutler.web',
    );
    expect(host).toContain('<key>Label</key><string>ai.openbutler.agent</string>');
    expect(web).toContain('<key>Label</key><string>ai.openbutler.web</string>');
  });

  it('rejects invalid variable names in builders', async () => {
    const service = await import('../src/daemon-autostart.js');
    expect(() => service.buildMacosDocument('/b', ['/e', 'daemon', 'run'], '/d', '/l', { 'NOPE!': 'x' })).toThrow(
      /invalid environment variable name/,
    );
  });

  it('reads the configured token from the process environment', async () => {
    const settings = await import('../src/settings.js');
    const service = await import('../src/daemon-autostart.js');
    expect(service.currentTelegramEnv()).toBeNull();
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'OPENBUTLER_TEST_TG_TOKEN', workspaceRoot: root };
    settings.saveSettings(store);
    vi.stubEnv('OPENBUTLER_TEST_TG_TOKEN', '123456:valid-token-value-here-ok');
    expect(service.currentTelegramEnv()).toEqual({ name: 'OPENBUTLER_TEST_TG_TOKEN', value: '123456:valid-token-value-here-ok' });
    const disabled = settings.defaultSettings();
    disabled.telegram = { enabled: false, tokenEnv: 'OPENBUTLER_TEST_TG_TOKEN', workspaceRoot: root };
    settings.saveSettings(disabled);
    expect(service.currentTelegramEnv()).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows login startup Telegram wiring', () => {
  it('leaves login startup alone on Windows, where the user environment covers it', async () => {
    const service = await import('../src/daemon-autostart.js');
    expect(service.refreshAutostartEnv()).toMatchObject({ updated: false });
    expect(service.refreshAutostartEnv().detail).toMatch(/user environment/);
  });
});
describe.skipIf(process.platform !== 'win32')('user Windows automatic startup ownership', () => {
  it('quotes the compiled entry, preserves the selected data directory, and removes only its owned registration', async () => {
    const service = await import('../src/daemon-autostart.js');
    service.installAutostart();
    expect(service.isAutostartInstalled()).toBe(true);
    const content = readFileSync(hostLauncher(), 'utf8');
    expect(content).toContain('OPENBUTLER_DATA_DIR');
    expect(content).toContain(root);
    expect(content).toContain('""' + process.argv[1] + '"" daemon run');
    expect(content).not.toContain('must-not-be-in-launcher');
    service.uninstallAutostart();
    expect(registry).toEqual({});
    expect(existsSync(hostLauncher())).toBe(false);
  });

  it('preserves an existing foreign startup command and accepts a development TypeScript entry', async () => {
    const service = await import('../src/daemon-autostart.js');
    registry.OpenButler = 'unrelated-user-command.exe';
    expect(() => service.installAutostart()).toThrow('another command');
    service.uninstallAutostart();
    expect(registry.OpenButler).toBe('unrelated-user-command.exe');
    expect(commands.run.mock.calls.some(([, args]) => args[0] === 'delete' || args[0] === 'add')).toBe(false);
    registry = {};
    process.argv[1] = join(root, 'cli.ts');
    expect(() => service.installAutostart()).not.toThrow();
    const launcher = readFileSync(hostLauncher(), 'utf8');
    expect(launcher).toContain('--import');
    expect(launcher).toContain('cli.ts');
  });

  it('starts the host and the browser client as two independent login entries', async () => {
    const service = await import('../src/daemon-autostart.js');
    const web = { host: '0.0.0.0', port: 45278, dir: root };
    service.installAutostart({ web });

    expect(service.isAutostartInstalled()).toBe(true);
    expect(service.isWebAutostartInstalled()).toBe(true);
    const host = readFileSync(hostLauncher(), 'utf8');
    const client = readFileSync(webLauncher(), 'utf8');
    expect(host).toContain('daemon run');
    expect(host).not.toContain('--web');
    expect(host).not.toContain('--serve');
    expect(client).toContain('web --serve');
    expect(client).toContain('--port 45278');
    expect(client).toContain('--hostname 0.0.0.0');
    expect(client).toContain('--dir');
    expect(client).not.toContain('daemon run');
    expect(registry.OpenButler).toContain('openbutler-logon.vbs');
    expect(registry.OpenButlerWeb).toContain('openbutler-web-logon.vbs');
    expect(service.readAutostartWeb()).toEqual(web);
  });

  it('preserves the saved web binding when only the host entry is reinstalled', async () => {
    const service = await import('../src/daemon-autostart.js');
    const web = { host: '0.0.0.0', port: 45278, dir: root };
    service.installAutostart({ web });
    service.installAutostart();
    expect(service.readAutostartWeb()).toEqual(web);
    expect(readFileSync(hostLauncher(), 'utf8')).not.toContain('--web');
    expect(readFileSync(webLauncher(), 'utf8')).toContain('web --serve');
  });

  it('removes only the web entry when web startup is turned off', async () => {
    const service = await import('../src/daemon-autostart.js');
    service.installAutostart({ web: { host: '0.0.0.0', port: 45278, dir: root } });
    service.installAutostart({ web: null });

    expect(service.isAutostartInstalled()).toBe(true);
    expect(service.isWebAutostartInstalled()).toBe(false);
    expect(registry.OpenButler).toBeDefined();
    expect(registry.OpenButlerWeb).toBeUndefined();
    expect(existsSync(hostLauncher())).toBe(true);
    expect(existsSync(webLauncher())).toBe(false);
    expect(service.readAutostartWeb()).toBeNull();
  });

  it('never overwrites a foreign web startup value', async () => {
    const service = await import('../src/daemon-autostart.js');
    registry.OpenButlerWeb = 'unrelated-web-command.exe';
    expect(() => service.installAutostart({ web: { host: '0.0.0.0', port: 45278, dir: root } })).toThrow('another command');
    expect(registry.OpenButlerWeb).toBe('unrelated-web-command.exe');
    expect(registry.OpenButler).toBeUndefined();
    expect(existsSync(hostLauncher())).toBe(false);
  });

  it('cleans both generated launchers if registration fails without modifying other startup data', async () => {
    const service = await import('../src/daemon-autostart.js');
    commands.run.mockImplementation((_program: string, args: string[]) =>
      args[0] === 'query' ? { status: 1, stdout: '', stderr: 'Not found' } : { status: 5, stdout: '', stderr: 'Fixture access denied' },
    );
    expect(() => service.installAutostart({ web: { host: '127.0.0.1', port: 45278, dir: root } })).toThrow('code 5');
    expect(existsSync(hostLauncher())).toBe(false);
    expect(existsSync(webLauncher())).toBe(false);
    expect(registry).toEqual({});
  });
});
