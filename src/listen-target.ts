import { isLoopback, isTailnetAddress } from './tailnet.js';

export interface DaemonListenTarget {
  host: string;
  port: number;
}

/**
 * Parse `--listen`: an IPv4 literal the daemon may bind (tailnet or loopback)
 * plus a port in 1-65535. The same rule the team hub binds by, because a
 * remote listener without a tailnet boundary would expose every session to
 * whatever can route to the machine. Settings and the CLI both validate
 * through here, so the saved preference and the flag it came from cannot
 * drift apart.
 */
export function parseListenTarget(spec: string): DaemonListenTarget {
  const trimmed = spec.trim();
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(trimmed);
  if (!match) throw new Error(`--listen needs an IPv4 address and port, e.g. 100.64.0.5:45280 (got "${spec}").`);
  const host = match[1]!;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error(`Listen port ${port} is out of range 1-65535.`);
  if (!isLoopback(host) && !isTailnetAddress(host))
    throw new Error(
      `${host} is not a tailnet address. The daemon binds the tailnet or loopback only; 0.0.0.0 and public addresses are refused.`,
    );
  return { host, port };
}
