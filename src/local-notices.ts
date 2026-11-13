/**
 * Client-local notices: messages a terminal client shows on its own, without
 * the host knowing about them (a dropped connection, a failed request, a host
 * lifecycle ping).
 *
 * They are not session entries, so they must not be pinned to the end of the
 * transcript: a notice that arrived ten minutes ago and stays below every new
 * message reads as if it had just happened, and it never leaves. Each notice
 * therefore remembers how many server entries existed when it arrived, and the
 * merge puts it back in that place. They also expire on their own, because
 * nothing else would ever remove them.
 */
import type { SessionEntry } from './session-store.js';

export type LocalNotice = { entry: SessionEntry; anchor: number; createdAt: number };

/** A notice older than this is dropped: the moment it describes has passed. */
export const LOCAL_NOTICE_TTL_MS = 120_000;
/** Oldest notices drop first beyond this count. */
export const MAX_LOCAL_NOTICES = 5;

export class LocalNoticeList {
  private items: LocalNotice[] = [];

  constructor(
    private readonly limit = MAX_LOCAL_NOTICES,
    private readonly ttlMs = LOCAL_NOTICE_TTL_MS,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** Adds a notice that belongs at `anchor`, the server entry count at arrival. */
  add(entry: SessionEntry, anchor: number, now = Date.now()): void {
    this.items = [...this.items, { entry, anchor: Math.max(0, anchor), createdAt: now }].slice(-this.limit);
  }

  /** The entries this list owns, so a merge can strip them from a returned view. */
  ownEntries(): Set<SessionEntry> {
    return new Set(this.items.map((item) => item.entry));
  }

  /** Drops expired notices. Returns true when something was removed. */
  prune(now = Date.now()): boolean {
    const kept = this.items.filter((item) => now - item.createdAt < this.ttlMs);
    if (kept.length === this.items.length) return false;
    this.items = kept;
    return true;
  }

  clear(): void {
    this.items = [];
  }

  /**
   * Server entries with the live notices put back where they arrived. Anchors
   * are absolute server entry counts; `entriesFrom` is the absolute index of
   * the first entry in the window the caller holds, so the anchor is
   * translated into that window before inserting. An anchor before the window
   * clamps to its top; one past its end clamps to its end. Anchors never
   * decrease relative to each other (the host only appends), so the insertion
   * offset accumulates.
   */
  merge(serverEntries: SessionEntry[], entriesFrom = 0, now = Date.now()): SessionEntry[] {
    this.prune(now);
    if (this.items.length === 0) return serverEntries;
    const merged = [...serverEntries];
    let inserted = 0;
    for (const item of this.items) {
      const index = Math.min(Math.max(item.anchor - entriesFrom + inserted, 0), merged.length);
      merged.splice(index, 0, item.entry);
      inserted++;
    }
    return merged;
  }
}
