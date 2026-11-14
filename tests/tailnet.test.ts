import { describe, expect, it } from 'vitest';
import { findTailnetAddress, isLoopback, isTailnetAddress } from '../src/tailnet.js';

describe('tailnet address handling', () => {
  it('accepts only the CGNAT range Tailscale uses', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('192.168.1.5')).toBe(false);
    expect(isTailnetAddress('10.0.0.1')).toBe(false);
    expect(isTailnetAddress('not-an-ip')).toBe(false);
  });

  it('finds the tailnet address among interfaces and ignores internal and non-tailnet ones', () => {
    const found = findTailnetAddress(() => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never],
      tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false } as never],
    }));
    expect(found).toBe('100.101.102.103');
    expect(findTailnetAddress(() => ({ eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never] }))).toBeNull();
  });
});

describe('loopback detection', () => {
  it('accepts every form a service may safely bind to locally', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.5.5.5')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('LocalHost')).toBe(true);
  });

  it('refuses every address that would leave the machine', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('100.64.0.1')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback('not-an-address')).toBe(false);
  });
});
