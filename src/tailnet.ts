import { networkInterfaces } from 'node:os';

/**
 * Address rules shared by every tailnet-scoped service: the Tailscale range
 * itself, the interface scan that finds this machine's tailnet address, and
 * loopback — the one bind target outside the tailnet that never leaves the
 * machine. Feature-specific join or port policy stays with its feature.
 */

/** Tailscale assigns addresses from the shared CGNAT range. Anything else is not the tailnet. */
const TAILNET_V4_BASE = 0x64400000; // 100.64.0.0
const TAILNET_V4_MASK = 0xffc00000; // /10

/** True for an IPv4 address inside 100.64.0.0/10. */
export function isTailnetAddress(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 255)) return false;
  const packed = ((numbers[0]! << 24) | (numbers[1]! << 16) | (numbers[2]! << 8) | numbers[3]!) >>> 0;
  return (packed & TAILNET_V4_MASK) === TAILNET_V4_BASE;
}

export type InterfaceLister = () => NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

/**
 * First non-internal IPv4 address in the tailnet range, or null when this
 * machine is not on a tailnet. The lister is injectable so tests never touch
 * the real interfaces.
 */
export function findTailnetAddress(lister: InterfaceLister = networkInterfaces): string | null {
  let interfaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
  try {
    interfaces = lister();
  } catch {
    return null;
  }
  for (const addresses of Object.values(interfaces)) {
    if (!addresses) continue;
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (isTailnetAddress(address.address)) return address.address;
    }
  }
  return null;
}

/**
 * True for a loopback target: the whole 127.0.0.0/8 range, ::1, or localhost.
 * A tailnet-scoped service accepts this as its one non-tailnet bind because
 * traffic to it never leaves the machine.
 */
export function isLoopback(address: string): boolean {
  if (address.toLowerCase() === 'localhost') return true;
  if (address === '::1') return true;
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 255)) return false;
  return numbers[0] === 127;
}
