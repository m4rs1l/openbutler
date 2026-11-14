import { readFileSync } from 'node:fs';
import { getDataPath } from './paths.js';
import { isLoopback, isTailnetAddress } from './tailnet.js';

/**
 * The backends a client can attach to, stored in the client's own data
 * directory. With no active entry every client stays on the local pipe, so an
 * install that never writes this file behaves exactly as before. An active
 * entry moves the connection onto TCP; a literal address obeys the same
 * tailnet rule the daemon binds by, while a name passes because only
 * Tailscale's MagicDNS resolves inside the tailnet. Token fields arrive with
 * pairing in a later phase.
 */
export interface BackendEntry {
  host: string;
  port: number;
}

export interface BackendRegistry {
  active: string | null;
  backends: Record<string, BackendEntry>;
}

const LOCAL_ONLY: BackendRegistry = { active: null, backends: {} };

export function backendRegistryPath(): string {
  return getDataPath('backends.json');
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
    const host = entry.host;
    const port = entry.port;
    if (typeof host !== 'string' || host.length === 0 || host.length > 253) throw new Error(`Backend "${name}" in ${path} needs a host.`);
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Backend "${name}" in ${path} needs a port 1-65535.`);
    if (/^[0-9.]+$/.test(host) && !isTailnetAddress(host) && !isLoopback(host))
      throw new Error(`Backend "${name}" in ${path} points at ${host}, which is outside the tailnet range 100.64.0.0/10.`);
    backends[name] = { host, port };
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
