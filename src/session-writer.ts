import { Worker } from 'node:worker_threads';
import type { SavedSession } from './session-store.js';

const workerSource = `
const { parentPort } = require('node:worker_threads');
const { writeFileSync, renameSync, rmSync } = require('node:fs');
parentPort.on('message', ({ id, path, session }) => {
  const temporary = path + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(session, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    parentPort.postMessage({ id });
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

function createWriter(): Worker {
  const current = new Worker(workerSource, { eval: true, execArgv: [] });
  current.on('message', (result: { id: number; error?: string }) => {
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    if (result.error !== undefined) request.reject(new Error(result.error));
    else request.resolve();
    if (pending.size === 0) current.unref();
  });
  const fail = (error: Error) => {
    if (worker !== current) return;
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  current.on('error', fail);
  current.on('exit', (code) => fail(new Error(`Session writer exited (${code}).`)));
  current.unref();
  return current;
}

export async function closeIdleSessionWriter(): Promise<void> {
  if (!worker || pending.size > 0) return;
  const current = worker;
  worker = null;
  await current.terminate();
}

// Structured clone does not preserve JSON hooks such as URL and Buffer.toJSON.
function cloneableJson(value: unknown, key = '', seen = new WeakMap<object, unknown>()): unknown {
  if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Number || value instanceof Boolean || value instanceof String) return value.valueOf();
  const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? new Array(value.length) : Object.create(null);
  seen.set(value, result);
  for (const name of Object.keys(value)) {
    Object.defineProperty(result, name, {
      value: cloneableJson((value as Record<string, unknown>)[name], name, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function writeSessionSnapshot(path: string, session: SavedSession): Promise<void> {
  worker ??= createWriter();
  const current = worker;
  const id = ++nextId;
  current.ref();
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      current.postMessage({ id, path, session: cloneableJson(session) });
    } catch (error) {
      pending.delete(id);
      if (pending.size === 0) current.unref();
      reject(error);
    }
  });
}
