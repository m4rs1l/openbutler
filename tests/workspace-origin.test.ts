import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let workspaceOrigin: typeof import('../src/workspace-origin.js');
let settings: typeof import('../src/settings.js');

async function saveDefaultWorkspace(path: string | undefined): Promise<void> {
  const store = settings.defaultSettings();
  if (path !== undefined) store.defaultWorkspaceRoot = path;
  settings.saveSettings(store);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-workspace-origin-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  settings = await import('../src/settings.js');
  workspaceOrigin = await import('../src/workspace-origin.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolvePath(root)) !== resolvePath(tmpdir()) || !basename(root).startsWith('openbutler-workspace-origin-'))
    throw new Error('Unsafe workspace-origin fixture cleanup path.');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('canonicalScopeRoot', () => {
  it('expands ~, resolves through symlinks, and requires a directory', () => {
    expect(workspaceOrigin.canonicalScopeRoot('~')).toBe(workspaceOrigin.canonicalScopeRoot(homedir()));

    const real = join(root, 'real-dir');
    mkdirSync(real);
    const link = join(root, 'link-dir');
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(workspaceOrigin.canonicalScopeRoot(link)).toBe(workspaceOrigin.canonicalScopeRoot(real));

    const file = join(root, 'plain-file');
    writeFileSync(file, 'x');
    expect(() => workspaceOrigin.canonicalScopeRoot(file)).toThrow(/Workspace path is not a directory/);
    expect(() => workspaceOrigin.canonicalScopeRoot('   ')).toThrow(/cannot be empty/);
    expect(() => workspaceOrigin.canonicalScopeRoot(join(root, 'missing-dir'))).toThrow();
  });
});

describe('scopeMapKey', () => {
  it('folds case on Windows only', () => {
    const root2 = join(root, 'MiXeD');
    const key = workspaceOrigin.scopeMapKey(root2);
    if (process.platform === 'win32') expect(key).toBe(root2.toLocaleLowerCase('en-US'));
    else expect(key).toBe(root2);
  });
});

describe('resolveInteractiveScope', () => {
  it('prefers the explicit path over the configured default', async () => {
    const explicit = join(root, 'explicit');
    const configured = join(root, 'configured');
    mkdirSync(explicit);
    mkdirSync(configured);
    await saveDefaultWorkspace(configured);
    expect(workspaceOrigin.resolveInteractiveScope({ explicitPath: explicit, cwd: join(root, 'other') })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(explicit),
      source: 'explicit',
    });
  });

  it('falls back to the configured default and then to the launch directory', async () => {
    const configured = join(root, 'configured');
    mkdirSync(configured);
    await saveDefaultWorkspace(configured);
    expect(workspaceOrigin.resolveInteractiveScope({ cwd: join(root, 'launch') })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(configured),
      source: 'settings',
    });

    await saveDefaultWorkspace(undefined);
    const launch = join(root, 'launch');
    mkdirSync(launch);
    expect(workspaceOrigin.resolveInteractiveScope({ cwd: launch })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(launch),
      source: 'launch',
    });
  });
});

describe('resolveServerScope', () => {
  it('prefers --dir and treats an empty flag as absent', async () => {
    const explicit = join(root, 'served');
    mkdirSync(explicit);
    expect(workspaceOrigin.resolveServerScope({ explicitDir: explicit })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(explicit),
      source: 'explicit',
    });
  });

  it('defaults to the machine workspace, never the launch directory', async () => {
    // A background browser service has no meaningful launch directory: an
    // arbitrary cwd must never become the scope a projectless chat runs in.
    // This mirrors configuredWorkspaceRoot in the host, which already refuses
    // "whatever directory the process happened to start in".
    const launch = join(root, 'arbitrary-launch');
    mkdirSync(launch);
    const scope = workspaceOrigin.resolveServerScope({});
    const machine = workspaceOrigin.canonicalScopeRoot(join(root, 'workspace'));
    expect(scope).toEqual({ root: machine, source: 'machine-default' });
    expect(workspaceOrigin.resolveServerScope({ explicitDir: '' })).toEqual({ root: machine, source: 'machine-default' });
    expect(scope.root).not.toBe(workspaceOrigin.canonicalScopeRoot(launch));
  });

  it('respects the configured default workspace ahead of the machine workspace', async () => {
    const configured = join(root, 'configured');
    mkdirSync(configured);
    await saveDefaultWorkspace(configured);
    expect(workspaceOrigin.resolveServerScope({})).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(configured),
      source: 'settings',
    });
  });
});

describe('machineWorkspaceRoot', () => {
  it('is the configured default, else the data-dir workspace', async () => {
    expect(workspaceOrigin.machineWorkspaceRoot()).toBe(workspaceOrigin.canonicalScopeRoot(join(root, 'workspace')));
    const configured = join(root, 'configured-machine');
    mkdirSync(configured);
    await saveDefaultWorkspace(configured);
    expect(workspaceOrigin.machineWorkspaceRoot()).toBe(workspaceOrigin.canonicalScopeRoot(configured));
  });

  it('never depends on the process launch directory', async () => {
    // The class invariant: a machine-level scope is the same no matter where the
    // process happened to start. A cwd fallback would silently move the
    // machine's work into an arbitrary folder.
    const elsewhere = join(root, 'arbitrary-launch');
    mkdirSync(elsewhere);
    const original = process.cwd();
    try {
      process.chdir(elsewhere);
      const actual = workspaceOrigin.machineWorkspaceRoot();
      const machine = workspaceOrigin.canonicalScopeRoot(join(root, 'workspace'));
      expect(actual).toBe(machine);
      expect(workspaceOrigin.resolveServerScope({}).root).toBe(machine);
    } finally {
      process.chdir(original);
    }
  });
});

describe('resolveBackgroundScope', () => {
  it('keeps the root it already owns untouched, without re-canonicalizing it', async () => {
    const previous = join(root, 'kept-as-is') + '/';
    expect(workspaceOrigin.resolveBackgroundScope({ previousRoot: previous, cwd: root })).toEqual({
      root: previous,
      source: 'stored',
    });
  });

  it('falls back to the configured default and then to the given directory', async () => {
    const configured = join(root, 'bg-configured');
    mkdirSync(configured);
    await saveDefaultWorkspace(configured);
    expect(workspaceOrigin.resolveBackgroundScope({ cwd: join(root, 'bg-cwd') })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(configured),
      source: 'settings',
    });

    await saveDefaultWorkspace(undefined);
    const cwd = join(root, 'bg-cwd');
    mkdirSync(cwd);
    expect(workspaceOrigin.resolveBackgroundScope({ cwd })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(cwd),
      source: 'custodian-dir',
    });
  });
});

describe('resolveRestoreScope', () => {
  it('ranks stored, event, settings and the launch directory in that order', async () => {
    const stored = join(root, 'stored');
    const event = join(root, 'event');
    const configured = join(root, 'restore-configured');
    const cwd = join(root, 'restore-cwd');
    for (const directory of [stored, event, configured, cwd]) mkdirSync(directory);
    await saveDefaultWorkspace(configured);

    expect(workspaceOrigin.resolveRestoreScope({ storedRoot: stored, eventRoot: event, cwd })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(stored),
      source: 'stored',
    });
    expect(workspaceOrigin.resolveRestoreScope({ eventRoot: event, cwd })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(event),
      source: 'stored',
    });
    expect(workspaceOrigin.resolveRestoreScope({ cwd })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(configured),
      source: 'settings',
    });

    await saveDefaultWorkspace(undefined);
    expect(workspaceOrigin.resolveRestoreScope({ cwd })).toEqual({
      root: workspaceOrigin.canonicalScopeRoot(cwd),
      source: 'custodian-dir',
    });
  });
});
