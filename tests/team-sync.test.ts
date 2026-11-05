import { describe, expect, it, vi } from 'vitest';
import { TeamSync } from '../src/team/sync.js';
import type { TeamConnection, TeamChannel } from '../src/team/session.js';

function connection(channel: Partial<TeamChannel>, current = () => true): TeamConnection {
  return { key: 'A', teamId: 'A', channel: channel as TeamChannel, isCurrent: current, close: () => {} };
}

describe('team capability reporting', () => {
  it('renews an unchanged capability observation before its freshness window expires', async () => {
    let now = 100_000;
    const reportCapabilities = vi.fn(async () => {});
    const sync = new TeamSync(
      () => connection({ reportCapabilities }),
      () => now,
    );
    const report = { platform: 'linux', mcpTools: [], mcpServers: [], custodianBusy: false };
    await sync.publishCapabilities(report);
    now += 10_000;
    await sync.publishCapabilities(report);
    expect(reportCapabilities).toHaveBeenCalledTimes(1);
    now += 10_000;
    await sync.publishCapabilities(report);
    expect(reportCapabilities).toHaveBeenCalledTimes(2);
  });
});
