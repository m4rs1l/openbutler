import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, readSections, saveSections } from './sidebar-state.js';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  } as Storage;
}

describe('sidebar section state', () => {
  it('starts with both sections open when nothing was stored', () => {
    expect(readSections(memoryStorage())).toEqual({ projects: true, recent: true });
  });

  it('round-trips a collapsed section across reloads', () => {
    const storage = memoryStorage();
    saveSections(storage, { projects: false, recent: true });
    expect(readSections(storage)).toEqual({ projects: false, recent: true });
  });

  it('falls back to the defaults on unreadable or partial data', () => {
    expect(readSections(memoryStorage({ 'openbutler:sidebar-sections:v1': 'not json' }))).toEqual(DEFAULT_SECTIONS);
    expect(readSections(memoryStorage({ 'openbutler:sidebar-sections:v1': '{"projects":false}' }))).toEqual({
      projects: false,
      recent: true,
    });
  });

  it('keeps the toggle working when storage itself throws', () => {
    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new Error('denied');
    };
    expect(() => saveSections(blocked, { projects: false, recent: false })).not.toThrow();
    expect(readSections(blocked)).toEqual(DEFAULT_SECTIONS);
  });
});
