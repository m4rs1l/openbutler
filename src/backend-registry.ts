import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from './paths.js';
import { isLoopback, isTailnetAddress } from './tailnet.js';

/**
 * The backends a client can attach to, stored in the client's own data
 * directory. With no active entry every client stays on the local pipe, so an
 * install that never writes this file behaves exactly as before. An active
 * entry moves the connection onto TCP; a literal address obeys the same
 * tailnet rule the daemon binds by, while a name passes because only
 * Tailscale's MagicDNS resolves inside the tailnet. `token` is the
 * credential the host's remote listener demands as its first frame; it is
 * absent on a local entry, and the handshake runs only when it is present.
 */
export interface BackendEntry {
  host: string;
  port: number;
  token?: string;
}

export interface BackendRegistry {
  active: string | null;
  backends: Record<string, BackendEntry>;
}

export interface SaveBackendOptions {
  /** Make this entry the one every local client dials; otherwise the current active entry stays. */
  activate?: boolean;
}

const LOCAL_ONLY: BackendRegistry = { active: null, backends: {} };

export function backendRegistryPath(): string {
  return getDataPath('backends.json');
}

/**
 * One shape for every acceptance rule, called with the location the error
 * should name: the reader points at the file it refused, the writer points at
 * the entry being saved. A stored entry loads only through these same rules,
 * so anything `saveBackend` accepts cannot later fail to parse.
 */
type RawBackendEntry = { host?: unknown; port?: unknown; token?: unknown };

function assertBackendEntry(entry: RawBackendEntry, location: string): void {
  const host = entry.host;
  const port = entry.port;
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) throw new Error(`${location} needs a host.`);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${location} needs a port 1-65535.`);
  if (/^[0-9.]+$/.test(host) && !isTailnetAddress(host) && !isLoopback(host))
    throw new Error(`${location} points at ${host}, which is outside the tailnet range 100.64.0.0/10.`);
  const token = (entry as { token?: unknown }).token;
  if (token !== undefined && (typeof token !== 'string' || token.length === 0 || token.length > 512))
    throw new Error(`${location} needs a token string of 1-512 characters.`);
}

/** A saved name is a label the CLI resolves (`use`, `remove`), so it is trimmed and bounded. */
function validateBackendName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) throw new Error(`A backend name must be 1-64 characters, got ${JSON.stringify(name)}.`);
  return trimmed;
}

/**
 * Writes the registry as owner-only wherever the platform honours mode bits.
 * The directory is created because the data dir may exist without this file,
 * and a failed write must not leave half a registry: the JSON is built before
 * the file is opened.
 */
function writeBackendRegistry(registry: BackendRegistry): void {
  const path = backendRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

export function readBackendRegistry(): BackendRegistry {
  const path = backendRegistryPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return LOCAL_ONLY;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The backend registry at ${path} is not valid JSON. Fix or delete it to return to the local host.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`The backend registry at ${path} must be a JSON object.`);
  const record = parsed as Record<string, unknown>;
  const active = record.active ?? null;
  if (active !== null && typeof active !== 'string') throw new Error(`The backend registry at ${path} has a non-string "active" value.`);
  const rawBackends = record.backends ?? {};
  if (typeof rawBackends !== 'object' || rawBackends === null || Array.isArray(rawBackends))
    throw new Error(`The backend registry at ${path} needs a "backends" object.`);
  const backends: Record<string, BackendEntry> = {};
  for (const [name, value] of Object.entries(rawBackends as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`Backend "${name}" in ${path} must be an object.`);
    const entry = value as Record<string, unknown>;
    assertBackendEntry(entry, `Backend "${name}" in ${path}`);
    const host = entry.host as string;
    const port = entry.port as number;
    const token = (entry as { token?: unknown }).token;
    backends[name] = token === undefined ? { host, port } : { host, port, token: token as string };
  }
  return { active, backends };
}

export function resolveActiveBackend(): BackendEntry | null {
  const registry = readBackendRegistry();
  if (registry.active === null) return null;
  const entry = registry.backends[registry.active];
  if (!entry) throw new Error(`Backend "${registry.active}" is not in the registry at ${backendRegistryPath()}.`);
  return entry;
}

/** Saves a backend, optionally making it the active one the clients dial. Prefer `setActiveBackend` to switch existing entries. */
export function saveBackend(name: string, entry: BackendEntry, options: SaveBackendOptions = {}): void {
  const key = validateBackendName(name);
  assertBackendEntry(entry, `Backend "${key}"`);
  const registry = readBackendRegistry();
  registry.backends[key] = entry.token === undefined ? { host: entry.host, port: entry.port } : { ...entry };
  if (options.activate === true) registry.active = key;
  writeBackendRegistry(registry);
}

/**
 * Removes a saved backend and reports whether it existed. Removing the active
 * entry deactivates it instead of silently promoting another backend: dialing
 * an unreviewed machine is a choice the owner makes with `use`.
 */
export function removeBackend(name: string): boolean {
  const key = name.trim();
  const registry = readBackendRegistry();
  if (!Object.hasOwn(registry.backends, key)) return false;
  delete registry.backends[key];
  if (registry.active === key) registry.active = null;
  writeBackendRegistry(registry);
  return true;
}

export function setActiveBackend(name: string): void {
  const key = name.trim();
  const registry = readBackendRegistry();
  if (!Object.hasOwn(registry.backends, key))
    throw new Error(`Backend "${key}" is not saved. Pair it first, or pick one from \`openbutler connect list\`.`);
  registry.active = key;
  writeBackendRegistry(registry);
}
