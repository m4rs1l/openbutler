import type { DaemonProcessOptions } from '../daemon.js';
import type { Parsed } from './args.js';

/**
 * `openbutler daemon run [--listen host:port]`: the remote listener a backend
 * install uses so clients can attach over the tailnet. A bare `--listen` is
 * refused instead of quietly starting without the listener that was asked for.
 */
export function daemonRunOptions(parsed: Parsed | undefined): DaemonProcessOptions {
  if (!parsed) return {};
  if (parsed.booleans.has('listen')) throw new Error('--listen needs an IPv4 address and port, e.g. --listen 100.64.0.5:45280.');
  const listen = parsed.flags.get('listen');
  return listen === undefined ? {} : { listen };
}
