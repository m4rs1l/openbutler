/**
 * Payload architecture of the release (Phase 5, v2): two flat archives composed
 * by flags, not one archive per role.
 *
 * Pins, without network and without installing:
 *  - scripts/payloads.mjs is the tracked source of truth for the two archive
 *    flavors (`daemon` base without the browser bundle, `web` overlay that is
 *    only app/dist/client) and their content specs;
 *  - install.sh parses `--daemon` | `--client` as the role (hints only) plus
 *    the `--web` modifier that fetches and merges the second archive; `--web`
 *    alone and `--binary --web` are refused before any network or file work;
 *  - the flavor marker records the full config string (`daemon+web`) and only
 *    an exact match may short-circuit, so adding `--web` really installs;
 *  - install.ps1 mirrors the same contract on Windows;
 *  - the shell installer parses (bash -n) and behaves on flag errors when a
 *    bash is available on this machine;
 *  - scripts/package-release.mjs, when the local untracked copy exists, maps
 *    the tracked rules onto the archives it builds.
 *
 * The browser-bundle serve guard lives with the same contract in
 * tests/web-bundle-guard.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const installSh = readFileSync(join(repo, 'install.sh'), 'utf8');
const installPs1 = readFileSync(join(repo, 'install.ps1'), 'utf8');

const CONFLICT_SH = 'Error: --daemon and --client cannot be combined.';
const CHOOSE_SH = 'Error: choose what to install:';
const WEB_REQUIRED_SH = 'Error: --web needs --daemon or --client.';
const BINARY_WEB_SH = 'Error: --binary cannot be combined with --web.';
const CONFLICT_PS1 = 'Error: -Daemon and -Client cannot be combined.';
const WEB_REQUIRED_PS1 = 'Error: -Web needs -Daemon or -Client.';
const BINARY_WEB_PS1 = 'Error: -Binary cannot be combined with -Web.';
const MARKER = '.openbutler-flavor';

// The four install outcomes, pinned at their exact wording. The shell quotes
// commands with double spaces; install.ps1 uses single spaces (Write-Host).
// Server roles begin with model setup: the host cannot start without one, so
// the hint names the step the first run actually hits.
const HINT_DAEMON =
  'Next: choose a model with  openbutler setup  then start the host with  openbutler daemon start  (add --listen <addr:port> for remote clients) and pair them with  openbutler pair';
const HINT_CLIENT = 'Next: pair a backend with  openbutler connect <host:port> --code <code>';
const HINT_CLIENT_WEB = `${HINT_CLIENT}  then open the UI with  openbutler web --backend <name>`;
const HINT_DAEMON_WEB = 'Next: choose a model with  openbutler setup  then start host and UI together with  openbutler daemon start --web';
const HINT_DAEMON_PS1 =
  'Next: choose a model with openbutler setup then start the host with openbutler daemon start (add --listen <addr:port> for remote clients) and pair them with openbutler pair';
const HINT_DAEMON_WEB_PS1 = 'Next: choose a model with openbutler setup then start host and UI together with openbutler daemon start --web';
const HINT_CLIENT_PS1 = 'Next: pair a backend with openbutler connect <host:port> --code <code>';
const HINT_CLIENT_WEB_PS1 = `${HINT_CLIENT_PS1} then open the UI with openbutler web --backend <name>`;

/** Occurrences of a needle in a haystack - pins branch duplication, not text. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('tracked payload rules (scripts/payloads.mjs)', () => {
  it('exposes the two archive flavors and nothing else', async () => {
    const payload = await import(pathToFileURL(join(repo, 'scripts', 'payloads.mjs')).href);
    expect(payload.FLAVORS).toEqual(['daemon', 'web']);
    expect(() => payload.assertFlavor('client')).toThrow(/expected daemon or web/i);
    expect(() => payload.assertFlavor('daemon')).not.toThrow();
    expect(() => payload.assertFlavor('web')).not.toThrow();
  });

  it('names the daemon archive per target and the web archive as one generic tar.gz', async () => {
    const payload = await import(pathToFileURL(join(repo, 'scripts', 'payloads.mjs')).href);
    expect(payload.archiveName('daemon', '0.8.0', 'linux-x64', 'tar.gz')).toBe('openbutler-daemon-0.8.0-linux-x64.tar.gz');
    expect(payload.archiveName('daemon', '0.8.0', 'windows-x64', 'zip')).toBe('openbutler-daemon-0.8.0-windows-x64.zip');
    // The overlay is static files only: target and format are fixed, so every
    // platform fetches the same bytes and the name carries neither.
    expect(payload.archiveName('web', '0.8.0', 'windows-x64', 'zip')).toBe('openbutler-web-0.8.0.tar.gz');
    expect(payload.archiveName('web', '0.8.0', 'linux-arm64', 'tar.gz')).toBe('openbutler-web-0.8.0.tar.gz');
  });

  it('rejects a missing flavor with the required-flag message', async () => {
    const payload = await import(pathToFileURL(join(repo, 'scripts', 'payloads.mjs')).href);
    expect(() => payload.assertFlavor(undefined)).toThrow('--flavor is required: daemon or web.');
    expect(() => payload.assertFlavor('')).toThrow('--flavor is required: daemon or web.');
  });

  it('describes both archive contents as archive-root-relative specs', async () => {
    const payload = await import(pathToFileURL(join(repo, 'scripts', 'payloads.mjs')).href);
    expect(payload.payloadSpec('daemon')).toEqual({ mode: 'exclude', paths: ['app/dist/client'] });
    expect(payload.payloadSpec('web')).toEqual({ mode: 'only', paths: ['app/dist/client'] });
    expect(() => payload.payloadSpec('client')).toThrow(/expected daemon or web/i);
  });
});

describe('install.sh contract (flags, archives, marker, hints)', () => {
  it('documents the composed invocations in the usage block', () => {
    expect(installSh).toContain('bash -s -- --daemon --web');
    expect(installSh).toContain('bash -s -- --client');
    // --help prints this exact range; extending the block must move the sed.
    expect(installSh).toMatch(/sed -n '2,\d+p' "\$0"/);
  });

  it('parses the role flags, the web modifier, and refuses every bad form early', () => {
    expect(installSh).toContain('--daemon | --client)');
    expect(installSh).toContain('--web) web="true"');
    expect(installSh).toContain(CONFLICT_SH);
    expect(installSh).toContain(WEB_REQUIRED_SH);
    expect(installSh).toContain(BINARY_WEB_SH);
    // Validation belongs in the flag guard: no curl, no target detection first.
    const needCurlAt = installSh.indexOf('need curl');
    expect(needCurlAt).toBeGreaterThan(0);
    for (const violation of [CHOOSE_SH, WEB_REQUIRED_SH, BINARY_WEB_SH]) {
      const at = installSh.indexOf(violation);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(needCurlAt);
    }
  });

  it('records the install config as role plus optional web overlay', () => {
    expect(installSh).toContain('config="${role}+web"');
  });

  it('builds both archive names, base always from the daemon payload', () => {
    // The role never reaches the name: --daemon and --client fetch the same
    // base bytes; only hints differ.
    const baseLine = 'filename="$APP-daemon-$specific_version-$target$archive_ext"';
    expect(count(installSh, baseLine)).toBe(2);
    const webLine = 'filename_web="$APP-web-$specific_version.tar.gz"';
    expect(count(installSh, webLine)).toBe(2);
  });

  it('writes the config marker and only exact matches may short-circuit', () => {
    expect(installSh).toContain(`> "$INSTALL_DIR/${MARKER}"`);
    expect(installSh).toContain('[ "$marker_config" = "$config" ]');
  });

  it('skips the base re-download when only the overlay is missing', () => {
    expect(installSh).toContain('skip_base="true"');
    expect(installSh).toContain('[ "$marker_config" = "$role" ]');
  });

  it('points at the config-specific next command, one branch per outcome', () => {
    expect(installSh).toContain('case "$config" in');
    expect(count(installSh, HINT_DAEMON)).toBe(1);
    expect(count(installSh, HINT_DAEMON_WEB)).toBe(1);
    expect(count(installSh, HINT_CLIENT)).toBe(2);
    expect(count(installSh, HINT_CLIENT_WEB)).toBe(1);
  });

  it('explains a release that does not carry the overlay archive', () => {
    expect(installSh).toContain('does not carry');
  });

  it('pre-flights every release download before the running host is touched', () => {
    // One shared check serves both version branches and both archives; the
    // branch-local copy is gone, and the check sits before any host stop.
    expect(count(installSh, 'verify_release_asset "$url" "$filename"')).toBe(1);
    expect(count(installSh, 'verify_release_asset "$url_web" "$filename_web"')).toBe(1);
    const preflightAt = installSh.indexOf('verify_release_asset "$url" "$filename"');
    expect(preflightAt).toBeGreaterThan(0);
    expect(preflightAt).toBeLessThan(installSh.indexOf('if stop_running_host; then'));
    expect(count(installSh, 'does not carry')).toBe(1);
    expect(installSh).toContain('could not reach GitHub to download');
  });

  it('brings a stopped host back when a later install step fails', () => {
    expect(installSh).toContain('starting it again');
    expect(installSh).toMatch(/start_running_host;\s*host_restored=1/);
  });
});

describe('install.ps1 contract', () => {
  it('takes the same switches and refuses every bad form up front', () => {
    expect(installPs1).toContain('[switch]$Web');
    expect(installPs1).toContain(CONFLICT_PS1);
    expect(installPs1).toContain(WEB_REQUIRED_PS1);
    expect(installPs1).toContain(BINARY_WEB_PS1);
    // Validation sits in the guard block, before any download machinery.
    const firstDownloadAt = installPs1.indexOf('function Get-RemoteMeta');
    expect(firstDownloadAt).toBeGreaterThan(0);
    for (const violation of [CHOOSE_SH, WEB_REQUIRED_PS1, BINARY_WEB_PS1]) {
      const at = installPs1.indexOf(violation);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(firstDownloadAt);
    }
  });

  it('records the config as role plus optional web overlay', () => {
    expect(installPs1).toContain('$Config = if ($Web) { "$Flavor+web" } else { $Flavor }');
    expect(installPs1).toContain('[IO.File]::WriteAllText($FlavorFile, $Config)');
    expect(installPs1).toContain('-and $installedConfig -eq $Config)');
  });

  it('builds both archive names, base always from the daemon payload', () => {
    expect(installPs1).toContain('$fileName = "$App-daemon-$specific-$target.zip"');
    expect(installPs1).toContain('$webFileName = "$App-web-$specific.tar.gz"');
  });

  it('extracts the generic overlay with tar, because it ships as tar.gz on every platform', () => {
    expect(installPs1).toContain('if ($Archive -like "*.tar.gz")');
    expect(installPs1).toContain('tar -xzf $Archive -C $Destination');
  });

  it('points at the config-specific next command', () => {
    expect(installPs1).toContain(HINT_DAEMON_PS1);
    expect(installPs1).toContain(HINT_DAEMON_WEB_PS1);
    expect(installPs1).toContain(HINT_CLIENT_PS1);
    expect(installPs1).toContain(HINT_CLIENT_WEB_PS1);
  });

  it('brings a stopped host back when a later install step fails', () => {
    // Downloads run before the stop on Windows, but a copy-stage failure must
    // still not leave a stopped host dead - and a clean run restarts once.
    expect(installPs1).toContain('starting it again');
    expect(installPs1).toMatch(/Start-RunningHost;\s*\$hostRestored = \$true/);
  });
});

/**
 * A bash for live pins. The shim under Git\\bin sets up the msys PATH; the
 * binary under Git\\usr\\bin inherits the Windows PATH only and cannot find
 * sed (measured: exit 127), so the shim comes first. The WSL launcher is the
 * last resort.
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

describeLive('install.sh live flag behavior (no network)', () => {
  // WSL needs a POSIX path for the script argument.
  const scriptArg = bash!.startsWith('bash')
    ? join(repo, 'install.sh')
        .replace(/^([A-Za-z]):/, (_drive, letter: string) => `/mnt/${letter.toLowerCase()}`)
        .replace(/\\/g, '/')
    : join(repo, 'install.sh');

  // Safety: even on a future script a flagless run might head for a download,
  // so every invocation points the installer at an unreachable repo and an
  // empty install dir. No network, no writes, wherever it exits.
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const env = {
      ...process.env,
      OPENBUTLER_GITHUB_REPO: '127.0.0.1:1/unreachable',
      OPENBUTLER_INSTALL_DIR: join(repo, 'node_modules', '.release-payloads-empty'),
      ...extraEnv,
    };
    try {
      const stdout = execFileSync(bash!, [...args], { timeout: 20_000, encoding: 'utf8', env });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };

  it('parses cleanly (bash -n)', () => {
    expect(run(['-n', scriptArg]).code).toBe(0);
  });

  it('--help lists the flag composition and exits 0', () => {
    const result = run([scriptArg, '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--daemon|--client');
  });

  it('refuses a flagless install with the choice message', () => {
    const result = run([scriptArg]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(CHOOSE_SH);
    expect(result.stderr).toContain('--daemon');
    expect(result.stderr).toContain('--web');
  });

  it('refuses --daemon --client together', () => {
    const result = run([scriptArg, '--daemon', '--client']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(CONFLICT_SH);
  });

  it('refuses --web without a role, naming the two roles', () => {
    const result = run([scriptArg, '--web']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(WEB_REQUIRED_SH);
    expect(result.stderr).not.toContain(CHOOSE_SH);
  });

  it('refuses --binary + --web before the file is even looked up', () => {
    const result = run([scriptArg, '--daemon', '--binary', 'missing-binary-file.zip', '--web']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(BINARY_WEB_SH);
    expect(result.stderr).not.toContain('binary archive not found');
  });

  it('names the missing overlay on the default (latest) path instead of falling into curl', () => {
    // BASH_ENV defines curl as a function (functions beat PATH, and the MSYS
    // bash always injects its own curl binary ahead of any PATH entry), so the
    // default path runs for real, offline, into a throwaway install dir: a
    // missing web archive must fail with the friendly 404 message, never a
    // raw download error after the host was touched.
    const stubDir = mkdtempSync(join(tmpdir(), 'ob-curl-stub-'));
    const installDir = mkdtempSync(join(tmpdir(), 'ob-payload-install-'));
    const envFile = join(stubDir, 'curl-stub.sh');
    writeFileSync(
      envFile,
      [
        'curl() { case "$*" in',
        '  *api.github.com*) echo \'{"tag_name":"v9.9.9"}\'; return 0;;',
        '  *openbutler-web-*) printf 404; return 22;;',
        '  *openbutler-daemon-*) printf 200; return 0;;',
        '  *) printf 000; return 7;;',
        'esac; }',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const result = run([scriptArg, '--daemon', '--web'], {
        OPENBUTLER_GITHUB_REPO: 'zxsmind/openbutler',
        OPENBUTLER_INSTALL_DIR: installDir,
        BASH_ENV: envFile,
      });
      expect(result.code).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('does not carry');
      expect(output).toContain('openbutler-web-9.9.9.tar.gz');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});

describe('local package-release.mjs (untracked; asserted only while present)', () => {
  const path = join(repo, 'scripts', 'package-release.mjs');
  const present = existsSync(path);
  (present ? describe : describe.skip)('maps the tracked rules onto the build', () => {
    const source = readFileSync(path, 'utf8');
    it('requires a flavor through the tracked rules', () => {
      expect(source).toContain("from './payloads.mjs'");
      expect(source).toContain('assertFlavor(');
      expect(source).toContain('--flavor daemon|web');
    });
    it('applies the tracked payload spec while assembling the archive', () => {
      expect(source).toContain('payloadSpec(');
      expect(source).toContain('app/dist/client');
    });
    it('picks the archive format from the file name, not from the build host', () => {
      // The generic web overlay is tar.gz even when built on Windows, so the
      // writer may not branch on process.platform for the format.
      expect(source).toContain("archive.endsWith('.zip')");
      expect(source).not.toContain("os === 'windows') run('tar'");
    });
  });
});
