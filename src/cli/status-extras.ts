import { readBackendRegistry } from '../backend-registry.js';
import { loadSettings } from '../settings.js';

/**
 * The two rows `daemon status` adds around the machine's own host facts: the
 * remote listener this install keeps, and the backend this client is paired
 * to. The paired backend is deliberately labeled "this command reports this
 * machine" — pairing moves sessions to the remote host, while status, config,
 * and usage keep reading local state, and a user must not read a local row as
 * a failed pairing.
 */
export function statusExtras(): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const listen = loadSettings().daemon?.listen;
  if (listen) rows.push(['Listener', `${listen} (remote clients attach here)`]);
  const registry = readBackendRegistry();
  const backend = registry.active === null ? undefined : registry.backends[registry.active];
  if (registry.active && backend) {
    rows.push(['Client backend', `${registry.active} (${backend.host}:${backend.port}) — sessions go there; this command reports this machine`]);
  }
  return rows;
}
