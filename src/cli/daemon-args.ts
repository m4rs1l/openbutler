import type { DaemonProcessOptions } from '../daemon.js';
import { loadSettings } from '../settings.js';
import type { Parsed } from './args.js';

/**
 * What `daemon start` does to this install's saved listener. A backend keeps
 * its listener as install state — the flag records it once and `daemon run`
 * binds it on every start, restart, and login boot — so the preference outlives
 * the command line that set it.
 */
export type ListenPreference = { kind: 'keep' } | { kind: 'save'; value: string } | { kind: 'clear' };

const NEEDS_VALUE = '--listen needs an IPv4 address and port, e.g. --listen 100.64.0.5:45280.';

function noListenRequested(parsed: Parsed): boolean {
  return parsed.booleans.has('no-listen') || parsed.flags.get('no-listen') === 'true';
}

export function listenPreference(parsed: Parsed | undefined): ListenPreference {
  if (!parsed) return { kind: 'keep' };
  const hasValue = parsed.flags.has('listen');
  const bare = parsed.booleans.has('listen');
  const cleared = noListenRequested(parsed);
  if ((hasValue || bare) && cleared) throw new Error('--listen and --no-listen conflict; pass one.');
  if (bare) throw new Error(NEEDS_VALUE);
  if (cleared) return { kind: 'clear' };
  if (hasValue) return { kind: 'save', value: parsed.flags.get('listen')! };
  return { kind: 'keep' };
}

function savedListen(): DaemonProcessOptions {
  const listen = loadSettings().daemon?.listen;
  return listen === undefined ? {} : { listen };
}

/**
 * `openbutler daemon run [--listen host:port]`: the remote listener a backend
 * install uses so clients can attach over the tailnet. An explicit flag is a
 * one-run override, `--no-listen` runs without the saved listener, and no flag
 * binds whatever this install saved. A bare `--listen` is refused instead of
 * quietly starting without the listener that was asked for.
 */
export function daemonRunOptions(parsed: Parsed | undefined): DaemonProcessOptions {
  if (!parsed) return savedListen();
  if (noListenRequested(parsed)) return {};
  if (parsed.booleans.has('listen')) throw new Error(NEEDS_VALUE);
  const listen = parsed.flags.get('listen');
  return listen === undefined ? savedListen() : { listen };
}
