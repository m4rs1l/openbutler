/** Which sidebar sections are open. A view preference, stored like the
 *  sidebar width and read through the same guarded access. */
const SECTIONS_KEY = 'openbutler:sidebar-sections:v1';

export interface SidebarSections {
  projects: boolean;
  recent: boolean;
}

export const DEFAULT_SECTIONS: SidebarSections = { projects: true, recent: true };

/** The page's storage when there is one: null outside a browser (server render,
 *  tests) and when the browser blocks storage access. */
export function sectionsStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function readSections(storage: Storage | null): SidebarSections {
  if (!storage) return { ...DEFAULT_SECTIONS };
  try {
    const raw = storage.getItem(SECTIONS_KEY);
    if (!raw) return { ...DEFAULT_SECTIONS };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ...DEFAULT_SECTIONS };
    const record = value as Record<string, unknown>;
    return {
      projects: readFlag(record.projects, DEFAULT_SECTIONS.projects),
      recent: readFlag(record.recent, DEFAULT_SECTIONS.recent),
    };
  } catch {
    // Private browsing can disable storage; the sections still toggle in-session.
    return { ...DEFAULT_SECTIONS };
  }
}

export function saveSections(storage: Storage | null, sections: SidebarSections): void {
  if (!storage) return;
  try {
    storage.setItem(SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    /* A blocked store must not stop the toggle from working. */
  }
}
