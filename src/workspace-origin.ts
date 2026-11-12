import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { getDataPath } from './paths.js';
import { loadSettings } from './settings.js';

/**
 * Where a workspace root came from. Every scope decision answers with one so a
 * status line, an attach result or a log can say why this folder is the one
 * that matters, instead of leaving callers to guess which fallback fired.
 */
export type ScopeSource = 'explicit' | 'stored' | 'settings' | 'launch' | 'custodian-dir' | 'machine-default';

export type WorkspaceResolution = { root: string; source: ScopeSource };

/**
 * The single workspace-path normalizer: expand `~`, resolve a relative path
 * against this process's directory, follow symlinks, and require a directory.
 * Every layer used to carry its own variant of this — two identical copies
 * plus several looser ones that disagreed on missing paths and error text —
 * so scope decisions now share this one implementation.
 */
export function canonicalScopeRoot(path: string): string {
  const requested = path.trim();
  if (!requested) throw new Error('Workspace path cannot be empty.');
  const expanded = requested === '~' ? homedir() : requested.replace(/^~(?=[/\\])/, homedir());
  const absolutePath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  const workspaceRoot = realpathSync(absolutePath);
  if (!statSync(workspaceRoot).isDirectory()) throw new Error(`Workspace path is not a directory: ${workspaceRoot}`);
  return workspaceRoot;
}

/** The identity key for workspace maps: the canonical root plus Windows case folding. */
export function scopeMapKey(root: string): string {
  return process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root;
}

/**
 * A bare terminal or question: an explicit `--workspace` wins, then the
 * configured default, and the directory the client was launched in is the
 * floor. The launch directory is the scope the owner meant, so it needs no
 * question: work there runs without permission prompts.
 */
export function resolveInteractiveScope(options: { explicitPath?: string | undefined; cwd: string }): WorkspaceResolution {
  if (options.explicitPath !== undefined && options.explicitPath !== '')
    return { root: canonicalScopeRoot(options.explicitPath), source: 'explicit' };
  const configured = loadSettings().defaultWorkspaceRoot;
  if (configured) return { root: canonicalScopeRoot(configured), source: 'settings' };
  return { root: canonicalScopeRoot(options.cwd), source: 'launch' };
}

/**
 * The machine's own workspace folder: the configured default, else the data-dir
 * workspace. The single authoritative fallback for any machine-level scope —
 * never "whatever directory the process happened to start in". A background
 * service has no meaningful launch directory, so a cwd fallback silently turns
 * an arbitrary folder into the place the machine's work lives.
 */
export function machineWorkspaceRoot(): string {
  const configured = loadSettings().defaultWorkspaceRoot;
  if (configured) return canonicalScopeRoot(configured);
  const folder = getDataPath('workspace');
  mkdirSync(folder, { recursive: true });
  return canonicalScopeRoot(folder);
}

/**
 * The browser server: `--dir` wins, then the machine workspace. Like
 * `machineWorkspaceRoot`, it never falls back to the launch cwd — that cwd used
 * to leak into every projectless browser chat as its workspace.
 */
export function resolveServerScope(options: { explicitDir?: string | undefined }): WorkspaceResolution {
  if (options.explicitDir !== undefined && options.explicitDir !== '')
    return { root: canonicalScopeRoot(options.explicitDir), source: 'explicit' };
  const configured = loadSettings().defaultWorkspaceRoot;
  return { root: machineWorkspaceRoot(), source: configured ? 'settings' : 'machine-default' };
}

/**
 * A background identity (custodian wakes and other host-owned work): the root
 * it already owns wins untouched, then the configured default, then this
 * process's directory — which `startDaemon` pins to the custodian folder, so
 * a normal host never inherits the directory the owner happened to launch from.
 */
export function resolveBackgroundScope(options: { previousRoot?: string | null | undefined; cwd: string }): WorkspaceResolution {
  if (options.previousRoot) return { root: options.previousRoot, source: 'stored' };
  const configured = loadSettings().defaultWorkspaceRoot;
  if (configured) return { root: canonicalScopeRoot(configured), source: 'settings' };
  return { root: canonicalScopeRoot(options.cwd), source: 'custodian-dir' };
}

/**
 * Restart recovery for a session whose host is gone: the session's own root,
 * then the event's, then the configured default, then this process's
 * directory. Unlike the background chain, stored roots are canonicalized
 * here — they may predate a symlink or a rename.
 */
export function resolveRestoreScope(options: {
  storedRoot?: string | null | undefined;
  eventRoot?: string | null | undefined;
  cwd: string;
}): WorkspaceResolution {
  if (options.storedRoot) return { root: canonicalScopeRoot(options.storedRoot), source: 'stored' };
  if (options.eventRoot) return { root: canonicalScopeRoot(options.eventRoot), source: 'stored' };
  const configured = loadSettings().defaultWorkspaceRoot;
  if (configured) return { root: canonicalScopeRoot(configured), source: 'settings' };
  return { root: canonicalScopeRoot(options.cwd), source: 'custodian-dir' };
}
