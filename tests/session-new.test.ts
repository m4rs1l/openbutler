import { describe, expect, it, vi } from 'vitest';
import { createSessionNewTool } from '../src/tools/session-new.js';

describe('session_new', () => {
  it('takes an instruction and nothing that could raise the new session authority', () => {
    const tool = createSessionNewTool(() => ({ status: 'created' }));
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    // Scope, model and approval mode are the host's to decide; a parameter here
    // would be a way to start a chat with more authority than its parent.
    expect(Object.keys(schema.properties ?? {})).toEqual(['instruction']);
    expect(schema.required).toEqual(['instruction']);
  });

  it('refuses an empty instruction without calling the host', async () => {
    const create = vi.fn();
    const tool = createSessionNewTool(create);
    const result = (await tool.execute!({ instruction: '   ' }, undefined, {})) as {
      status: string;
    };
    expect(result.status).toBe('invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an instruction longer than the transcript can carry', async () => {
    const create = vi.fn();
    const tool = createSessionNewTool(create);
    const result = (await tool.execute!({ instruction: 'x'.repeat(8_001) }, undefined, {})) as {
      status: string;
    };
    expect(result.status).toBe('invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('passes the instruction and the caller id to the host', async () => {
    const create = vi.fn(async () => ({ status: 'created', session: 'abc' }));
    const tool = createSessionNewTool(create);
    const result = await tool.execute!({ instruction: 'Map the repository.' }, undefined, { sessionId: 'custodian' });
    expect(create).toHaveBeenCalledWith({ instruction: 'Map the repository.' }, 'custodian');
    expect(result).toEqual({ status: 'created', session: 'abc' });
  });

  it('reports a host failure as a tool result instead of throwing', async () => {
    const tool = createSessionNewTool(() => {
      throw new Error('host is shutting down');
    });
    const result = (await tool.execute!({ instruction: 'Map the repository.' }, undefined, {})) as { status: string; error?: string };
    expect(result.status).toBe('error');
    expect(result.error).toContain('host is shutting down');
  });
});
