/**
 * The resolver must behave identically on any computer, so every test its
 * drives through injected platform, environment and existence probe. No test
 * reads the host PATH, the host filesystem, or the value of a real variable.
 */
import { describe, expect, it } from 'vitest';
import {
  isShellPreset,
  isShellSettingValue,
  resolveShell,
  SHELL_PRESETS,
  pathProbe,
  type ResolveShellOptions,
  type WhereProbe,
} from '../src/tools/shell.js';

type Probe = (candidate: string) => boolean;

/** A synthetic machine: nothing here consults the real host. */
function machine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, has: Probe): ResolveShellOptions {
  return { platform, env, has };
}

const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
const CMD_FLAGS = ['/d', '/s', '/c'];
const POSIX_FLAGS = ['-c'];

describe('preset and settings-shape guards', () => {
  it('accepts exactly the documented presets', () => {
    expect([...SHELL_PRESETS]).toEqual(['auto', 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl', 'bash', 'zsh', 'sh']);
    expect(isShellPreset('wsl')).toBe(true);
    expect(isShellPreset('vwsl')).toBe(false);
  });

  it('accepts presets and path-shaped values in settings, refuses unknown words', () => {
    expect(isShellSettingValue('auto')).toBe(true);
    expect(isShellSettingValue('  pwsh ')).toBe(true);
    expect(isShellSettingValue('/usr/bin/bash')).toBe(true);
    expect(isShellSettingValue('C:\\shells\\sh.exe')).toBe(true);
    expect(isShellSettingValue('fish')).toBe(false);
    expect(isShellSettingValue('')).toBe(false);
  });

  it('refuses an unknown word at resolve time instead of guessing', () => {
    expect(() =>
      resolveShell(
        'fishy',
        machine('win32', {}, () => true),
      ),
    ).toThrow(/commandShell must be one of/);
  });

  it('treats an empty value as auto', () => {
    const shell = resolveShell(
      '',
      machine('win32', {}, () => true),
    );
    expect(shell.executable).toBe('pwsh');
    expect(shell.label).toBe('pwsh (powershell, auto)');
  });
});

describe('auto', () => {
  it('prefers the newest Windows shell when the machine has it all', () => {
    const shell = resolveShell(
      undefined,
      machine('win32', {}, () => true),
    );
    expect(shell).toEqual({ executable: 'pwsh', launcherArgs: POWERSHELL_FLAGS, dialect: 'powershell', label: 'pwsh (powershell, auto)' });
  });

  it('falls back to Windows PowerShell when there is no pwsh', () => {
    const probe: Probe = (candidate) => candidate === 'powershell';
    const shell = resolveShell('auto', machine('win32', {}, probe));
    expect(shell.executable).toBe('powershell');
    expect(shell.launcherArgs).toEqual(POWERSHELL_FLAGS);
  });

  it('ends the Windows walk at cmd', () => {
    const shell = resolveShell(
      'auto',
      machine('win32', {}, () => false),
    );
    expect(shell).toEqual({ executable: 'cmd', launcherArgs: CMD_FLAGS, dialect: 'cmd', label: 'cmd (cmd, auto)' });
  });

  it('honours $SHELL on POSIX when it exists', () => {
    const env = { SHELL: '/zsh/bin/zsh', PATH: '/usr/bin' } satisfies NodeJS.ProcessEnv;
    const shell = resolveShell(
      undefined,
      machine('darwin', env, (candidate) => candidate === '/zsh/bin/zsh'),
    );
    expect(shell).toEqual({ executable: '/zsh/bin/zsh', launcherArgs: POSIX_FLAGS, dialect: 'posix', label: 'zsh (posix, auto)' });
  });

  it('falls back to /bin/sh when $SHELL names nothing that exists', () => {
    const env = { SHELL: '/missing/zsh' } satisfies NodeJS.ProcessEnv;
    const shell = resolveShell(
      undefined,
      machine('linux', env, () => false),
    );
    expect(shell.executable).toBe('/bin/sh');
    expect(shell.dialect).toBe('posix');
  });
});

describe('presets', () => {
  it('keeps the exact Windows PowerShell flags the tool used before', () => {
    const shell = resolveShell(
      'powershell',
      machine('win32', {}, () => false),
    );
    expect(shell).toEqual({
      executable: 'powershell',
      launcherArgs: POWERSHELL_FLAGS,
      dialect: 'powershell',
      label: 'powershell (powershell, preset)',
    });
  });

  it('resolves pwsh by name on every platform and keeps its dialect', () => {
    const shell = resolveShell(
      'pwsh',
      machine('linux', {}, () => true),
    );
    expect(shell.executable).toBe('pwsh');
    expect(shell.dialect).toBe('powershell');
    expect(shell.launcherArgs).toEqual(POWERSHELL_FLAGS);
  });

  it('runs cmd through its own flag triple', () => {
    const shell = resolveShell(
      'cmd',
      machine('win32', {}, () => false),
    );
    expect(shell.launcherArgs).toEqual(CMD_FLAGS);
    expect(shell.dialect).toBe('cmd');
  });

  it('hands bash, zsh and sh plain POSIX flags', () => {
    for (const name of ['bash', 'zsh', 'sh'] as const) {
      const shell = resolveShell(
        name,
        machine('linux', {}, () => false),
      );
      expect(shell).toEqual({ executable: name, launcherArgs: POSIX_FLAGS, dialect: 'posix', label: `${name} (posix, preset)` });
    }
  });

  it('sends wsl through bash -c inside the guest', () => {
    const shell = resolveShell(
      'wsl',
      machine('win32', {}, () => false),
    );
    expect(shell).toEqual({ executable: 'wsl.exe', launcherArgs: ['-e', 'bash', '-c'], dialect: 'posix', label: 'wsl (posix, preset)' });
  });
});

describe('git-bash discovery', () => {
  it('prefers bash found on PATH over any install root', () => {
    const env = { PATH: 'C:\\Shells', ProgramFiles: 'C:\\Apps' } satisfies NodeJS.ProcessEnv;
    const probe: Probe = (candidate) => candidate === 'C:\\Shells\\bash.exe' || candidate === 'C:\\Apps\\Git\\bin\\bash.exe';
    const shell = resolveShell('git-bash', machine('win32', env, probe));
    expect(shell.executable).toBe('C:\\Shells\\bash.exe');
    expect(shell.dialect).toBe('posix');
  });

  it('skips the WSL stub directories and keeps a real bash', () => {
    const env = {
      PATH: ['C:\\Windows\\System32', 'C:\\Shells'].join(';'),
      LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
    } satisfies NodeJS.ProcessEnv;
    const probe: Probe = (candidate) => candidate === 'C:\\Windows\\System32\\bash.exe' || candidate === 'C:\\Shells\\bash.exe';
    const shell = resolveShell('git-bash', machine('win32', env, probe));
    expect(shell.executable).toBe('C:\\Shells\\bash.exe');
  });

  it('uses install roots stated by the environment when PATH has no bash', () => {
    const env = { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps32' } satisfies NodeJS.ProcessEnv;
    const probe: Probe = (candidate) => candidate === 'C:\\Apps32\\Git\\bin\\bash.exe';
    const shell = resolveShell('git-bash', machine('win32', env, probe));
    expect(shell.executable).toBe('C:\\Apps32\\Git\\bin\\bash.exe');
    expect(shell.label).toBe('bash (posix, preset)');
  });

  it('explains itself when no bash exists anywhere', () => {
    const env = { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Apps' } satisfies NodeJS.ProcessEnv;
    expect(() =>
      resolveShell(
        'git-bash',
        machine('win32', env, () => false),
      ),
    ).toThrow(/git-bash was not found/);
  });
});

describe('explicit paths', () => {
  it('treats a path like its preset twin, dialect from the filename', () => {
    const probe: Probe = (candidate) => candidate === 'C:\\Apps\\pwsh\\pwsh.exe';
    const shell = resolveShell('C:\\Apps\\pwsh\\pwsh.exe', machine('win32', {}, probe));
    expect(shell).toEqual({
      executable: 'C:\\Apps\\pwsh\\pwsh.exe',
      launcherArgs: POWERSHELL_FLAGS,
      dialect: 'powershell',
      label: 'pwsh (powershell, path)',
    });
  });

  it('runs an absolute POSIX path with POSIX flags', () => {
    const shell = resolveShell(
      '/opt/shells/mysh',
      machine('linux', {}, (candidate) => candidate === '/opt/shells/mysh'),
    );
    expect(shell).toEqual({ executable: '/opt/shells/mysh', launcherArgs: POSIX_FLAGS, dialect: 'posix', label: 'mysh (posix, path)' });
  });

  it('refuses a path that does not exist instead of falling back', () => {
    expect(() =>
      resolveShell(
        'C:\\Gone\\sh.exe',
        machine('win32', {}, () => false),
      ),
    ).toThrow(/does not exist/);
  });
});

describe('pathProbe asks where.exe only when stat is blind', () => {
  /** Windows cannot stat what App-Execution-Alias exposes; nothing on PATH exists. */
  const BLIND = { PATH: 'C:\\\\Store-only', PATHEXT: '.EXE' } satisfies NodeJS.ProcessEnv;

  it('trusts a where.exe hit on win32', () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const where: WhereProbe = (command, args) => {
      seen.push({ command, args });
      return { status: 0, stdout: 'C:\\\\Store\\\\pwsh.exe\r\n' };
    };
    expect(pathProbe(BLIND, 'win32', where)('pwsh')).toBe(true);
    expect(seen).toEqual([{ command: 'where.exe', args: ['pwsh'] }]);
  });

  it('treats a where.exe miss as absent', () => {
    const where: WhereProbe = () => ({ status: 1, stdout: '' });
    expect(pathProbe(BLIND, 'win32', where)('pwsh')).toBe(false);
  });

  it('never falls back outside win32', () => {
    const where: WhereProbe = () => ({ status: 0, stdout: '/usr/bin/pwsh\n' });
    expect(pathProbe(BLIND, 'linux', where)('pwsh')).toBe(false);
  });

  it('uses where.exe for explicit paths too, once stat fails', () => {
    const where: WhereProbe = () => ({ status: 0, stdout: 'C:\\\\Store\\\\pwsh.exe\r\n' });
    expect(pathProbe(BLIND, 'win32', where)('C:\\\\Store\\\\pwsh.exe')).toBe(true);
  });
});
