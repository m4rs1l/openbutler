import { describe, expect, it } from 'vitest';
import type { UsageRow } from '../src/activity-ledger.js';
import { assignRoleModel, isModelRole, modelRoles, resolveRoleModel, roleModelAssignment, roleModelConfig } from '../src/model-roles.js';
import type { SettingsStore } from '../src/settings.js';

function settings(): SettingsStore {
  return {
    defaultProvider: '',
    defaultModel: '',
    providerOrder: ['fixture', 'ghost'],
    approvalMode: 'workspace',
    schedules: [],
    mcpServers: {},
    providers: {
      fixture: {
        enabled: true,
        npm: '@ai-sdk/gateway',
        url: 'https://gateway.example/v1',
        keys: ['k'],
        models: ['modelx', 'flash'],
      },
      ghost: { enabled: false, npm: '@ai-sdk/gateway', url: 'https://ghost.example/v1', keys: ['k'], models: ['dead-model'] },
    },
  };
}

/** A configured custom provider counts as usable without a loaded catalog. */
const row = (providerId: string, modelId: string, atMs: number): UsageRow => ({ providerId, modelId, atMs }) as UsageRow;

const untouchedLedger = {
  usageRows: (): UsageRow[] => {
    throw new Error('usage must not be read when the answer is already decided');
  },
};

const usageLedger = {
  usageRows: (): UsageRow[] => [row('fixture', 'flash', 1_000), row('fixture', 'flash', 2_000), row('fixture', 'modelx', 3_000)],
};

describe('resolveRoleModel', () => {
  it('prefers the role assignment with source role and never reads usage', () => {
    const store = settings();
    store.roles = { worker: { provider: 'fixture', model: 'flash' } };
    const choice = resolveRoleModel(store, 'worker', untouchedLedger);
    expect(choice).toEqual({ providerId: 'fixture', modelId: 'flash', source: 'role' });
  });

  it('falls back to the explicit default when the role is unset', () => {
    const store = settings();
    store.defaultProvider = 'fixture';
    store.defaultModel = 'modelx';
    expect(resolveRoleModel(store, 'worker', untouchedLedger)).toEqual({ providerId: 'fixture', modelId: 'modelx', source: 'settings' });
  });

  it('degrades a broken role target to the default instead of failing the run', () => {
    const store = settings();
    store.defaultProvider = 'fixture';
    store.defaultModel = 'modelx';
    store.roles = { worker: { provider: 'ghost', model: 'dead-model' } };
    // Ghost is disabled: the assignment cannot be used, so the role falls through.
    expect(resolveRoleModel(store, 'worker')).toEqual({ providerId: 'fixture', modelId: 'modelx', source: 'settings' });
  });

  it('falls all the way to usage when nothing is set', () => {
    expect(resolveRoleModel(settings(), 'agent', usageLedger)).toEqual({
      providerId: 'fixture',
      modelId: 'flash',
      source: 'usage',
      requests: 2,
    });
  });

  it('reads the legacy reviewer and custodian pairs as their roles', () => {
    const store = settings();
    store.autoReviewProvider = 'fixture';
    store.autoReviewModel = 'flash';
    store.custodian = { provider: 'fixture', model: 'modelx' };
    expect(roleModelAssignment(store, 'review')).toEqual({ providerId: 'fixture', modelId: 'flash' });
    expect(roleModelAssignment(store, 'custodian')).toEqual({ providerId: 'fixture', modelId: 'modelx' });
    expect(roleModelAssignment(store, 'title')).toBeNull();
  });

  it('lets an explicit roles entry take precedence over the legacy pair', () => {
    const store = settings();
    store.autoReviewProvider = 'fixture';
    store.autoReviewModel = 'flash';
    store.roles = { review: { provider: 'fixture', model: 'modelx' } };
    expect(roleModelAssignment(store, 'review')).toEqual({ providerId: 'fixture', modelId: 'modelx' });
  });
});

describe('assignRoleModel', () => {
  it('writes the pair and mirrors the legacy reviewer fields together', () => {
    const store = settings();
    assignRoleModel(store, 'review', { providerId: 'fixture', modelId: 'flash' });
    expect(store.roles?.review).toEqual({ provider: 'fixture', model: 'flash' });
    expect(store.autoReviewProvider).toBe('fixture');
    expect(store.autoReviewModel).toBe('flash');
    assignRoleModel(store, 'review', null);
    expect(store.roles).toBeUndefined();
    expect(store.autoReviewProvider).toBeUndefined();
    expect(store.autoReviewModel).toBeUndefined();
  });

  it('keeps other roles independent and empties the map cleanly', () => {
    const store = settings();
    assignRoleModel(store, 'worker', { providerId: 'fixture', modelId: 'flash' });
    assignRoleModel(store, 'title', { providerId: 'fixture', modelId: 'modelx' });
    expect(store.roles).toEqual({ worker: { provider: 'fixture', model: 'flash' }, title: { provider: 'fixture', model: 'modelx' } });
    assignRoleModel(store, 'worker', null);
    assignRoleModel(store, 'title', null);
    expect(store.roles).toBeUndefined();
  });

  it('must not touch the custodian legacy pair', () => {
    const store = settings();
    store.custodian = { provider: 'fixture', model: 'modelx' };
    assignRoleModel(store, 'custodian', { providerId: 'fixture', modelId: 'flash' });
    expect(store.roles?.custodian).toEqual({ provider: 'fixture', model: 'flash' });
    expect(store.custodian.provider).toBe('fixture');
    expect(store.custodian.model).toBe('modelx');
  });
});

describe('roleModelConfig and role names', () => {
  it('changes identity only when the pair or its provider config changes', () => {
    const store = settings();
    const before = roleModelConfig(store, 'worker');
    expect(roleModelConfig(store, 'worker')).toBe(before);
    assignRoleModel(store, 'worker', { providerId: 'fixture', modelId: 'modelx' });
    const assigned = roleModelConfig(store, 'worker');
    expect(assigned).not.toBe(before);
    expect(roleModelConfig(store, 'worker')).toBe(assigned);
    store.providers.fixture!.keys = ['rotated'];
    expect(roleModelConfig(store, 'worker')).not.toBe(assigned);
  });

  it('names exactly the roles the system assigns and rejects anything else', () => {
    expect(modelRoles()).toEqual(['agent', 'custodian', 'worker', 'background', 'title', 'review']);
    expect(isModelRole('worker')).toBe(true);
    expect(isModelRole('default')).toBe(false);
    expect(isModelRole('__proto__')).toBe(false);
  });
});
