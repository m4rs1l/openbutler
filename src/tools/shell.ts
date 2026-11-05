/**
 * The shell execute_command launches, resolved by rules that hold on any machine.
 *
 * Discovery reads only what every system already publishes: PATH (the exact
 * lookup spawn performs), PATHEXT on Windows, $SHELL on POSIX, and install
 * roots expressed through environment variables. No location found on this
 * computer is recorded here. Tests inject platform, environment and the
 * existence probe, so the resolver never consults the host to be checked.
 *
 * One setting, three shapes: unset or "auto" walks a fixed preference order,
 * a preset names a program, a path runs as given. The prose contract matches
 * resolveShell: settings.ts validates the shape, this module resolves it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Shell family command text is written for; it decides the launcher flags. */
export type ShellDialect = 'posix' | 'powershell' | 'cmd';

export interface ResolvedShell {
  /** Program for spawn: either a PATH name or an absolute path. */
  executable: string;
  /** Arguments placed before the command string itself. */
  launcherArgs: string[];
  dialect: ShellDialect;
  /** Identity for the tool description and About: "pwsh (powershell, auto)". */
  label: string;
}

/** Every accepted non-path value of commandShell. */
export const SHELL_PRESETS = ['auto', 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl', 'bash', 'zsh', 'sh'] as const;
export type ShellPreset = (typeof SHELL_PRESETS)[number];

export function isShellPreset(value: string): value is ShellPreset {
  return (SHELL_PRESETS as readonly string[]).includes(value);
}

/** Settings-shape check: a preset name or anything path-shaped. Mirrors resolveShell's accepted input. */
export function isShellSettingValue(value: string): boolean {
  const trimmed = value.trim();
  return isShellPreset(trimmed) || trimmed.includes('/') || trimmed.includes('\\');
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Existence probe; defaults to a PATH lookup. Tests inject a synthetic one. */
  has?: (candidate: string) => boolean;
}

// Flags belong to the dialect, never to a machine: PowerShell and CMD parse
// their own command line, POSIX shells read one trailing string, and WSL
// execs bash inside the guest without wrapping another Windows-side shell.
const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
const CMD_FLAGS = ['/d', '/s', '/c'];
const POSIX_FLAGS = ['-c'];
const WSL_FLAGS = ['-e', 'bash', '-c'];

function baseName(executable: string): string {
  return (executable.split(/[\\/]/).pop() ?? executable).toLowerCase().replace(/\.exe$/, '');
}

/**
 * The executable's own filename picks the dialect, so an arbitrary path maps
 * exactly like its preset twin: ...\pwsh.exe behaves like "pwsh", anything
 * else is POSIX (-c), which covers bash, zsh, sh, fish and friends.
 */
function dialectOf(executable: string): ShellDialect {
  const base = baseName(executable);
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}

function flagsFor(dialect: ShellDialect): string[] {
  if (dialect === 'powershell') return [...POWERSHELL_FLAGS];
  if (dialect === 'cmd') return [...CMD_FLAGS];
  return [...POSIX_FLAGS];
}

function entry(executable: string, dialect: ShellDialect, source: 'auto' | 'preset' | 'path', flags?: string[]): ResolvedShell {
  return {
    executable,
    launcherArgs: flags ?? flagsFor(dialect),
    dialect,
    label: `${baseName(executable)} (${dialect}, ${source})`,
  };
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
}

export type WhereProbe = (command: string, args: string[]) => { status: number | null; stdout: string };

/** Windows resolves App-Execution-Alias reparse points (fresh PowerShell from
 *  the Store) for `where` and for CreateProcess, but stat(2) on them fails, so
 *  a plain existsSync says no to a program that runs. Fall back to the
 *  system's own name resolver, never to a location this machine recorded. */
export const systemWhereProbe: WhereProbe = (command, args) => {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2000, windowsHide: true });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/** Probe for the `auto`/path walk: stat each PATH candidate first (works on
 *  every system), then ask `where.exe` (win32 only) when stat itself is blind. */
export function pathProbe(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  where: WhereProbe = systemWhereProbe,
): (candidate: string) => boolean {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [];
  return (candidate) => {
    if (candidate.includes('/') || candidate.includes('\\')) {
      return existsSync(candidate) || (platform === 'win32' && whereFound(where, candidate));
    }
    const names = [candidate, ...extensions.map((ext) => `${candidate}${ext.toLowerCase()}`)];
    for (const dir of pathDirs(env)) for (const name of names) if (existsSync(join(dir, name))) return true;
    return platform === 'win32' ? whereFound(where, candidate) : false;
  };
}

function whereFound(where: WhereProbe, candidate: string): boolean {
  const result = where('where.exe', [candidate]);
  return result.status === 0 && result.stdout.trim() !== '';
}

/**
 * Windows hosts two unrelated `bash.exe` launchers: the WSL stubs in
 * System32 and WindowsApps, and real shells such as Git Bash. A stub is not
 * a shell this setting promised, so `git-bash` skips those directories.
 */
function isWslStubDir(dir: string): boolean {
  // The directory may end right after the name, so the separator after it is optional.
  return /[\\/](?:system32|windowsapps)(?:[\\/]|$)/i.test(dir);
}

/**
 * Bash outside PATH can only be found through install roots the environment
 * itself states; none of them is hard-coded. PATH wins when it lists bash,
 * so a user who already selected one keeps that choice.
 */
function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs'),
  ].filter((root): root is string => typeof root === 'string' && root !== '');
  return roots.map((root) => join(root, 'Git', 'bin', 'bash.exe'));
}

function findGitBash(env: NodeJS.ProcessEnv, has: (candidate: string) => boolean): string | null {
  for (const dir of pathDirs(env)) {
    if (isWslStubDir(dir)) continue;
    for (const name of ['bash.exe', 'bash']) {
      const candidate = join(dir, name);
      if (has(candidate)) return candidate;
    }
  }
  for (const candidate of gitBashCandidates(env)) if (has(candidate)) return candidate;
  return null;
}

function resolveAuto(platform: NodeJS.Platform, has: (candidate: string) => boolean, env: NodeJS.ProcessEnv): ResolvedShell {
  if (platform === 'win32') {
    // Newest first; a missing program only ends the walk later, never earlier.
    if (has('pwsh')) return entry('pwsh', 'powershell', 'auto');
    if (has('powershell')) return entry('powershell', 'powershell', 'auto');
    return entry('cmd', 'cmd', 'auto');
  }
  if (env.SHELL !== undefined && env.SHELL !== '' && has(env.SHELL)) {
    const dialect = dialectOf(env.SHELL);
    return entry(env.SHELL, dialect, 'auto');
  }
  return entry('/bin/sh', 'posix', 'auto');
}

/**
 * Turns the configured value into a launch plan, or explains precisely why
 * it cannot. Unknown words are refused instead of guessed at, and a path
 * that vanished is an error at command time rather than a silent fallback.
 */
export function resolveShell(configured: string | undefined, options: ResolveShellOptions = {}): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const has = options.has ?? pathProbe(env, platform);
  const value = configured?.trim() || 'auto';

  if (value.includes('/') || value.includes('\\')) {
    if (!has(value)) throw new Error(`commandShell points at a path that does not exist: ${value}`);
    return entry(value, dialectOf(value), 'path');
  }
  if (!isShellPreset(value)) {
    throw new Error(`commandShell must be one of ${SHELL_PRESETS.join(', ')} or an executable path; got "${value}"`);
  }
  if (value === 'auto') return resolveAuto(platform, has, env);
  if (value === 'git-bash') {
    const found = findGitBash(env, has);
    if (found === null) {
      throw new Error(
        'commandShell git-bash was not found on PATH or in the install roots of this system; add bash to PATH or set commandShell to its full path',
      );
    }
    return entry(found, 'posix', 'preset');
  }
  if (value === 'wsl') return entry(platform === 'win32' ? 'wsl.exe' : 'wsl', 'posix', 'preset', [...WSL_FLAGS]);
  // pwsh | powershell | cmd | bash | zsh | sh: a plain PATH name whose own
  // filename already decides the dialect and the flags.
  return entry(value, dialectOf(value), 'preset');
}
