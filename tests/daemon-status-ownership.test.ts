/**
 * Host-stop ownership (2026-11-15 incident): an install into ANY directory
 * used to stop the machine's running host, because `daemon status` probes the
 * script's own entry to its install dir — then replaced only its own tree.
 * Whoever held the pipe lost their daemon.
 *
 * Pins, red first: `daemon status --json` reports `running` plus an `ours`
 * verdict computed where both install dirs are native (TS, findInstallDir on
 * both entries); install.sh should act on that verdict and leave a foreign or
 * unverifiable host alone, in both directions (free CLI / stale binary);
 * legacy CLIs without --json keep stopping only in the default directory the
 * one-install contract was written for. install.ps1 mirrors the same gate.
 *
 * The live cases run the real install.sh end to end offline through --binary,
 * each staging a stub installer tree whose launcher answers status and logs
 * stop/start, so a foreign stop or a lost restart fails the test outright.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { daemonStatusReport } from '../src/daemon.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const installSh = readFileSync(join(repo, 'install.sh'), 'utf8');
const installPs1 = readFileSync(join(repo, 'install.ps1'), 'utf8');

const LEAVE_ALONE = 'Leaving the running host alone: it was started by another installation.';
const STOPPING = 'Stopping the background host so its files can be replaced.';
const STARTING = 'Starting the background host on the new version.';

/** A root laid out like a real installer tree: `app/`, `node/`, `bin/`. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openbutler-status-own-'));
  mkdirSync(join(root, 'app', 'dist'), { recursive: true });
  mkdirSync(join(root, 'node'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'app', 'dist', 'cli.js'), '// fixture host entry\n');
  return root;
}

describe('daemon status --json ownership verdict (daemon.ts)', () => {
  it('answers {"running":false} without a host', () => {
    expect(daemonStatusReport(null, null)).toBe('{"running":false}');
    expect(daemonStatusReport(null, '/opt/openbutler')).toBe('{"running":false}');
  });

  it('marks a host from the same install as ours, pid preserved', () => {
    const root = fixtureRoot();
    try {
      const entry = join(root, 'app', 'dist', 'cli.js');
      const report = daemonStatusReport({ pid: 4242, startedAt: 'now', workspaceCount: 1, connectedClients: 0, entry }, root);
      expect(JSON.parse(report)).toEqual({ running: true, pid: 4242, ours: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks a host from another install as not ours', () => {
    const host = fixtureRoot();
    const mine = fixtureRoot();
    try {
      const entry = join(host, 'app', 'dist', 'cli.js');
      const report = daemonStatusReport({ pid: 7, startedAt: 'now', workspaceCount: 0, connectedClients: 0, entry }, mine);
      expect(JSON.parse(report)).toEqual({ running: true, pid: 7, ours: false });
    } finally {
      rmSync(host, { recursive: true, force: true });
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it('never claims a host it cannot locate (legacy or unresponsive pid)', () => {
    const root = fixtureRoot();
    try {
      const report = daemonStatusReport({ pid: 9, startedAt: 'now', workspaceCount: 0, connectedClients: 0 }, root);
      expect(JSON.parse(report)).toEqual({ running: true, pid: 9, ours: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never claims a host when the caller is outside an install tree', () => {
    const root = fixtureRoot();
    try {
      const entry = join(root, 'app', 'dist', 'cli.js');
      const report = daemonStatusReport({ pid: 3, startedAt: 'now', workspaceCount: 0, connectedClients: 0, entry }, null);
      expect(JSON.parse(report)).toEqual({ running: true, pid: 3, ours: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  if (process.platform === 'win32') {
    it('compares install roots case-insensitively on Windows', () => {
      const root = fixtureRoot();
      try {
        const entry = join(root, 'app', 'dist', 'cli.js');
        const spoofedCase = root.replace(/openbutler-status-own-/i, 'OPENBUTLER-STATUS-OWN-');
        if (spoofedCase !== root) {
          expect(
            JSON.parse(daemonStatusReport({ pid: 1, startedAt: 'n', workspaceCount: 0, connectedClients: 0, entry }, spoofedCase)),
          ).toEqual({
            running: true,
            pid: 1,
            ours: true,
          });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('installer source gates', () => {
  it('install.sh asks the JSON verdict before touching the host', () => {
    expect(installSh).toContain('daemon status --json');
    expect(installSh).toContain(LEAVE_ALONE);
    // Stale-binary fallback: only the historical default directory may stop.
    expect(installSh).toContain('[ "$INSTALL_DIR" != "$HOME/.openbutler" ]');
  });

  it('install.ps1 mirrors the verdict gate', () => {
    expect(installPs1).toContain('daemon status --json');
    expect(installPs1).toContain('| ConvertFrom-Json');
    expect(installPs1).toContain(LEAVE_ALONE);
    expect(installPs1).toContain("if ($InstallDir -ne (Join-Path $HOME '.openbutler'))");
  });
});

/**
 * A bash for live pins: the Git shim carries the msys PATH (Git\usr\bin does
 * not, measured exit 127 on sed); WSL is the last resort.
 */
function findBash(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash',
  ];
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ['-c', 'echo ok'], { timeout: 10_000, encoding: 'utf8' });
      if (out.includes('ok')) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const bash = findBash();
const describeLive = bash ? describe : describe.skip;

type Fixture = {
  home: string;
  dir: string;
  /** True when the fixture IS `$HOME/.openbutler`; the installer then derives
   * the path itself, exactly as a default-directory install always has. */
  defaultDir: boolean;
  argvLog: string;
  argv2Log: string;
  zip: string;
  dispose: () => void;
};

const WRAPPER_NODE = (logPath: string) => `#!/bin/sh
case " $* " in
  *" --version "*) echo 0.7.0 ;;
  *" daemon start "*) echo "daemon start" >> "${logPath}" ;;
esac
echo 0.7.0
`;

const STUB_LAUNCHER = `#!/bin/sh
d="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$1" = "--version" ]; then echo 0.7.0; exit 0; fi
if [ "$1" = "daemon" ] && [ "$2" = "status" ]; then
  if [ "\${3:-}" = "--json" ]; then
    [ -f "$d/status-json.txt" ] || exit 1
    cat "$d/status-json.txt"
    exit 0
  fi
  cat "$d/status.txt"
  exit 0
fi
if [ "$1" = "daemon" ] && [ "$2" = "stop" ]; then echo "daemon stop" >> "$d/.argv.log"; exit 0; fi
if [ "$1" = "daemon" ] && [ "$2" = "start" ]; then echo "daemon start" >> "$d/.argv.log"; exit 0; fi
exit 1
`;

/**
 * Stages a fake installed tree: a stub launcher answering status both ways,
 * a written flavor marker one config away from the requested role, and a
 * binary zip whose bundled `node.exe` is a shell wrapper, so the real
 * installer runs its full stop-install-restart path with no network.
 */
function makeFixture(options: { home?: boolean; json?: string | null } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'openbutler-own-home-'));
  const dir = options.home ? join(home, '.openbutler') : mkdtempSync(join(tmpdir(), 'openbutler-own-install-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'app', 'dist'), { recursive: true });
  const launcher = join(dir, 'bin', 'openbutler');
  writeFileSync(launcher, STUB_LAUNCHER);
  chmodSync(launcher, 0o755);
  writeFileSync(join(dir, 'status.txt'), 'Background host running (pid 7).\n');
  if (options.json !== null && options.json !== undefined) writeFileSync(join(dir, 'status-json.txt'), options.json);
  // One config step away from `daemon`, so the short-circuit cannot win.
  writeFileSync(join(dir, '.openbutler-flavor'), 'client\n');

  const argvLog = join(dir, '.argv.log');
  const argv2Log = join(dir, '.argv2.log');
  const zipDir = join(home, 'zipstage');
  mkdirSync(join(zipDir, 'openbutler', 'node', 'bin'), { recursive: true });
  mkdirSync(join(zipDir, 'openbutler', 'app', 'dist'), { recursive: true });
  writeFileSync(join(zipDir, 'openbutler', 'node', 'bin', 'node.exe'), WRAPPER_NODE(argv2Log.split('\\').join('/')));
  writeFileSync(join(zipDir, 'openbutler', 'app', 'dist', 'cli.js'), '// rebuilt by the installer\n');
  const zip = join(home, 'fixture.zip');
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path "${zipDir}\\openbutler" -DestinationPath "${zip}" -Force`],
    {
      timeout: 60_000,
      encoding: 'utf8',
    },
  );
  return {
    home,
    dir,
    defaultDir: options.home === true,
    argvLog,
    argv2Log,
    zip,
    dispose: () => {
      rmSync(home, { recursive: true, force: true });
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* already inside home */
      }
    },
  };
}

type RunResult = { code: number; stdout: string; stderr: string };

describeLive('install.sh host-ownership gate (offline, real script)', () => {
  const scriptArg = join(repo, 'install.sh');

  const run = (fixture: Fixture): RunResult => {
    const posixPath = (path: string) => path.split('\\').join('/');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENBUTLER_GITHUB_REPO: '127.0.0.1:1/unreachable',
      HOME: posixPath(fixture.home),
    };
    // A default-directory install never overrides the path: bash derives
    // `$HOME/.openbutler` itself (both spellings then come from one source).
    if (fixture.defaultDir) delete env.OPENBUTLER_INSTALL_DIR;
    else env.OPENBUTLER_INSTALL_DIR = posixPath(fixture.dir);
    const args = ['-c', `bash "${scriptArg}" --daemon --binary "${posixPath(fixture.zip)}" --no-modify-path`];
    try {
      const stdout = execFileSync(bash!, args, { timeout: 60_000, encoding: 'utf8', env });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };

  const argvCalls = (fixture: Fixture): string => (existsSync(fixture.argvLog) ? readFileSync(fixture.argvLog, 'utf8') : '');

  it('leaves a foreign host alone and installs anyway', () => {
    const fixture = makeFixture({ json: '{"running":true,"pid":987,"ours":false}' });
    try {
      const result = run(fixture);
      expect(result.stdout).toContain(LEAVE_ALONE);
      expect(result.stdout).toContain('Installing openbutler from');
      expect(argvCalls(fixture)).not.toContain('daemon stop');
    } finally {
      fixture.dispose();
    }
  });

  it('stops and restarts its own host through the whole binary path', () => {
    const fixture = makeFixture({ json: '{"running":true,"pid":987,"ours":true}' });
    try {
      const result = run(fixture);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(STOPPING);
      expect(result.stdout).toContain(STARTING);
      expect(argvCalls(fixture)).toContain('daemon stop');
      expect(readFileSync(fixture.argv2Log, 'utf8')).toContain('daemon start');
    } finally {
      fixture.dispose();
    }
  });

  it('does nothing to a machine with no host running', () => {
    const fixture = makeFixture({ json: '{"running":false}' });
    try {
      const result = run(fixture);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(STOPPING);
      expect(result.stdout).not.toContain(LEAVE_ALONE);
      expect(argvCalls(fixture)).not.toContain('daemon stop');
    } finally {
      fixture.dispose();
    }
  });

  it('a CLI too old for --json still leaves a foreign-directory host alone', () => {
    const fixture = makeFixture({ json: null });
    try {
      const result = run(fixture);
      expect(result.stdout).toContain(LEAVE_ALONE);
      expect(result.stdout).toContain('Installing openbutler from');
      expect(argvCalls(fixture)).not.toContain('daemon stop');
    } finally {
      fixture.dispose();
    }
  });

  it('a CLI too old for --json keeps stopping the default-directory host', () => {
    const fixture = makeFixture({ home: true, json: null });
    try {
      const result = run(fixture);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(STOPPING);
      expect(argvCalls(fixture)).toContain('daemon stop');
    } finally {
      fixture.dispose();
    }
  });
});
