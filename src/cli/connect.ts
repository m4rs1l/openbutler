import { input } from '@inquirer/prompts';
import { pairWithBackend } from '../daemon-client.js';
import { readBackendRegistry, removeBackend, saveBackend, setActiveBackend } from '../backend-registry.js';
import { isLoopback, isTailnetAddress } from '../tailnet.js';
import type { Parsed } from './args.js';
import * as ui from './ui.js';

const USAGE = 'Usage: openbutler connect <host:port> --code <code> [--name <name>] | list | remove <name> | use <name>';

export interface ConnectTarget {
  host: string;
  port: number;
}

/**
 * One dialed backend: `host:port`, where a literal IPv4 must be loopback or
 * tailnet (the same rule the daemon binds by) and any other name reaches
 * Tailscale's DNS inside the tailnet. IPv6 is deliberately out: the daemon
 * listener is IPv4 and a bracketed form would join ambiguously.
 */
export function parseConnectTarget(target: string): ConnectTarget {
  const separator = target.lastIndexOf(':');
  const host = separator === -1 ? '' : target.slice(0, separator).trim();
  const portRaw = separator === -1 ? '' : target.slice(separator + 1).trim();
  if (host === '' || portRaw === '')
    throw new Error(`A backend target must be host:port, for example 100.64.0.5:45280. Got ${JSON.stringify(target)}.`);
  if (host.length > 253) throw new Error(`The host part is too long to be a backend address.`);
  if (/^[0-9.]+$/.test(host) && !isTailnetAddress(host) && !isLoopback(host))
    throw new Error(`${host} is outside the tailnet range 100.64.0.0/10. Only tailnet or loopback addresses can be dialed.`);
  if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535)
    throw new Error(`A backend port must be 1-65535, got ${JSON.stringify(portRaw)}.`);
  return { host, port: Number(portRaw) };
}

/** `openbutler connect …` — pair with a backend or manage the saved list. */
export async function runConnect(parsed: Parsed): Promise<void> {
  // `parsed.words` drops the command word, so this starts at the first real argument.
  const sub = parsed.words[0];

  if (sub === 'list') {
    const registry = readBackendRegistry();
    const names = Object.keys(registry.backends);
    if (!names.length) {
      ui.info('No saved backends. Pair this client with: openbutler connect <host:port> --code <code>');
      return;
    }
    ui.table(
      ['NAME', 'ENDPOINT', 'ACTIVE'],
      names.map((key) => {
        const entry = registry.backends[key]!;
        return [key, `${entry.host}:${entry.port}`, registry.active === key ? 'yes' : ''];
      }),
    );
    return;
  }

  if (sub === 'remove') {
    const name = parsed.words[1]?.trim();
    if (!name) throw new Error(USAGE);
    if (!removeBackend(name)) throw new Error(`No saved backend named "${name}". List them with: openbutler connect list`);
    ui.success(`Removed backend "${name}".`);
    return;
  }

  if (sub === 'use') {
    const name = parsed.words[1]?.trim();
    if (!name) throw new Error(USAGE);
    setActiveBackend(name);
    ui.success(`Backend "${name}" is now the one this client dials.`);
    return;
  }

  if (!sub) throw new Error(USAGE);

  const target = parseConnectTarget(sub);
  let code = parsed.flags.get('code')?.trim();
  if (!code) {
    if (!process.stdin.isTTY) throw new Error(`Pairing needs the code shown by \`openbutler pair\` on the host: pass --code <code>.`);
    code = (await input({ message: `Pairing code from ${target.host}:${target.port} (openbutler pair):` })).trim();
  }
  if (!code) throw new Error('The pairing code cannot be empty. Run `openbutler pair` on the backend and enter what it prints.');
  const token = await pairWithBackend(target.host, target.port, code);
  const name = parsed.flags.get('name')?.trim() || target.host;
  saveBackend(name, { host: target.host, port: target.port, token }, { activate: true });
  ui.success(`Paired with ${target.host}:${target.port} as "${name}". This client now talks to that backend.`);
  ui.info('Manage saved backends with: openbutler connect list | use <name> | remove <name>');
}
