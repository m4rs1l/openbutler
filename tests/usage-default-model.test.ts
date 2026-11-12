import { describe, expect, it, vi } from 'vitest';
import type { UsageRow } from '../src/activity-ledger.js';
import type { SettingsStore } from '../src/settings.js';
import { pickMostUsedModel, resolveDefaultModel } from '../src/usage/default-model.js';

function settings(defaultProvider = '', defaultModel = ''): SettingsStore {
  return {
    defaultProvider,
    defaultModel,
    providerOrder: ['fixture', 'ghost'],
    approvalMode: 'workspace',
    schedules: [],
    mcpServers: {},
    providers: {
      fixture: { enabled: true, npm: '@ai-sdk/gateway', url: 'https://gateway.example/v1', keys: ['k'] },
      ghost: { enabled: false, npm: '@ai-sdk/gateway', url: 'https://ghost.example/v1', keys: ['k'] },
    },
  };
}

const ledgerFake = vi.hoisted(() => {
  const state = { opened: 0, closed: 0, rows: [] as UsageRow[] };
  class FakeLedger {
    constructor() {
      state.opened++;
    }
    usageRows() {
      return state.rows;
    }
    close() {
      state.closed++;
    }
  }
  return { state, FakeLedger };
});

vi.mock('../src/activity-ledger.js', () => ({ ActivityLedger: ledgerFake.FakeLedger }));

const row = (providerId: string, modelId: string, atMs: number): UsageRow => ({ providerId, modelId, atMs }) as UsageRow;

const untouchedLedger = {
  usageRows: (): UsageRow[] => {
    throw new Error('usage must not be read when the default is explicit');
  },
};

describe('pickMostUsedModel', () => {
  it('ranks by request count with recency breaking ties', () => {
    const rows = [
      row('fixture', 'modelx', 1_000),
      row('fixture', 'modelx', 2_000),
      row('fixture', 'modelx', 3_000),
      row('fixture', 'flash', 4_000),
      row('fixture', 'flash', 5_000),
      row('fixture', 'flash', 9_000),
    ];
    expect(pickMostUsedModel(settings(), rows)).toEqual({ providerId: 'fixture', modelId: 'flash', requests: 3 });
  });

  it('skips disabled providers and unknown entries', () => {
    const rows = [
      row('ghost', 'dead-model', 9_000),
      row('fixture', 'modelx', 1_000),
      row('ghost', 'dead-model', 8_000),
      row('ghost', 'dead-model', 7_000),
    ];
    expect(pickMostUsedModel(settings(), rows)).toEqual({ providerId: 'fixture', modelId: 'modelx', requests: 1 });
    expect(pickMostUsedModel(settings(), [])).toBeNull();
    expect(pickMostUsedModel(settings('fixture', 'modelx'), [])).toBeNull();
  });
});

describe('resolveDefaultModel', () => {
  it('returns an explicit default without touching usage', () => {
    const choice = resolveDefaultModel(settings('fixture', 'modelx'), untouchedLedger);
    expect(choice).toEqual({ providerId: 'fixture', modelId: 'modelx', source: 'settings' });
  });

  it('closes the ledger it opened for usage rows', () => {
    ledgerFake.state.opened = 0;
    ledgerFake.state.closed = 0;
    ledgerFake.state.rows = [row('fixture', 'modelx', 1_000)];
    expect(resolveDefaultModel(settings())).toEqual({ providerId: 'fixture', modelId: 'modelx', source: 'usage', requests: 1 });
    expect(ledgerFake.state.opened).toBe(1);
    expect(ledgerFake.state.closed).toBe(1);
  });

  it('leaves a caller-provided ledger open', () => {
    const close = vi.fn();
    const ledger = { usageRows: () => [row('fixture', 'modelx', 1_000)], close };
    expect(resolveDefaultModel(settings(), ledger)).toEqual({ providerId: 'fixture', modelId: 'modelx', source: 'usage', requests: 1 });
    expect(close).not.toHaveBeenCalled();
  });

  it('falls back to usage when no explicit default exists', () => {
    const ledger = { usageRows: () => [row('fixture', 'modelx', 1_000), row('fixture', 'modelx', 2_000)] };
    expect(resolveDefaultModel(settings(), ledger)).toEqual({
      providerId: 'fixture',
      modelId: 'modelx',
      source: 'usage',
      requests: 2,
    });
  });

  it('stays null when usage offers nothing usable', () => {
    const ledger = { usageRows: () => [row('ghost', 'dead-model', 1_000)] };
    expect(resolveDefaultModel(settings(), ledger)).toBeNull();
  });
});
