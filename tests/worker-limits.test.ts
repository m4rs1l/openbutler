import { describe, expect, it } from 'vitest';
import { workerLimitError } from '../src/daemon-host.js';
import { CUSTODIAN_WORKER_CAP_DEFAULTS } from '../src/settings.js';

const caps = CUSTODIAN_WORKER_CAP_DEFAULTS;

describe('worker concurrency caps', () => {
  it('allows a spawn below every cap', () => {
    expect(workerLimitError({ parentDepth: 0, runningForParent: 7, runningTotal: 9, caps })).toBeNull();
    expect(workerLimitError({ parentDepth: 1, runningForParent: 1, runningTotal: 4, caps })).toBeNull();
  });

  it('refuses the ninth worker of a main session', () => {
    const error = workerLimitError({ parentDepth: 0, runningForParent: 8, runningTotal: 9, caps });
    expect(error).toContain('limit 8');
  });

  it('gives a worker parent a limit of two children', () => {
    const error = workerLimitError({ parentDepth: 1, runningForParent: 2, runningTotal: 4, caps });
    expect(error).toContain('limit 2');
  });

  it('refuses at ten running workers machine-wide even when the parent has room', () => {
    const error = workerLimitError({ parentDepth: 0, runningForParent: 0, runningTotal: 10, caps });
    expect(error).toContain('limit 10');
    expect(error).toContain('machine');
  });

  it('refuses at the width it is given, not at the shipped default', () => {
    const narrowed = { perSession: 1, perWorkerParent: 1, perMachine: 3, depth: 1 };
    expect(workerLimitError({ parentDepth: 0, runningForParent: 0, runningTotal: 0, caps: narrowed })).toBeNull();
    expect(workerLimitError({ parentDepth: 0, runningForParent: 1, runningTotal: 1, caps: narrowed })).toContain('limit 1');
    expect(workerLimitError({ parentDepth: 1, runningForParent: 1, runningTotal: 2, caps: narrowed })).toContain('limit 1');
    expect(workerLimitError({ parentDepth: 0, runningForParent: 0, runningTotal: 3, caps: narrowed })).toContain('limit 3');
  });
});
