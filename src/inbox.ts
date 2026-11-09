import { createHash } from 'node:crypto';
import { DELIVERIES_KEY, type ToolDelivery } from './delivery.js';

/**
 * One pending notification. The metadata exists so a reader can choose which
 * notification to open without opening any: who sent it, from where, and when.
 * No content ever travels here - that is what `read` is for.
 */
export interface InboxItem {
  reference: string;
  receivedAt: string;
  state: 'unread' | 'read';
  /** Who the notification is from: an agent, a peer, the owner. */
  from?: string;
  /** One short line about what it is, never the body. */
  subject?: string;
}

export interface InboxSource {
  name: string;
  list: (sessionId: string) => Promise<{ items: InboxItem[]; remaining?: number }>;
  /**
   * Opens the notification: the content comes back and the item leaves the box.
   *
   * A source that hands over a record the caller must not be asked about
   * again declares the delivery here. The declaration is what the host records
   * as "the caller has it", so it travels with the content instead of being
   * guessed from it afterwards.
   */
  read: (
    references: readonly string[],
    sessionId: string,
  ) => Promise<Array<{ reference: string; content: unknown; delivery?: ToolDelivery }>>;
}

export interface InboxRequest {
  action: 'list' | 'read';
  source?: string;
  ids?: readonly string[];
  limit?: number;
  offset?: number;
}

/**
 * A notification id is a short code a model can copy without transcoding a uuid:
 * six Crockford base32 characters (`A6GX9H`), with I, L, O and U left out because
 * they are read as 1, 1, 0 and V. The code is derived from the source and the
 * reference and nothing else, so it needs no table of its own: the pending
 * notifications are the only durable record, and the box rebuilds its codes from
 * them on every pass. A code therefore lives exactly as long as the notification.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 12;

/** The short code for one notification key (`source|reference`), derived, never stored. */
export function inboxCodeFor(key: string, length = CODE_LENGTH): string {
  const digest = createHash('sha256').update(key, 'utf8').digest();
  let code = '';
  for (let index = 0; index < length; index += 1) code += CODE_ALPHABET[digest[index % digest.length]! % CODE_ALPHABET.length];
  return code;
}

export function inboxId(source: string, reference: string): string {
  return `${encodeURIComponent(source)}:${encodeURIComponent(reference)}`;
}

export function inboxNotice(source: string, count: number): string {
  return `You have ${count} ${JSON.stringify(source)} notification${count === 1 ? '' : 's'}. Use inbox to read.`;
}

interface PendingNotification {
  source: string;
  item: InboxItem;
}

interface CodedNotification extends PendingNotification {
  id: string;
}

/** Oldest first, then by source and reference so every pass sees the same order. */
function byAge(left: PendingNotification, right: PendingNotification): number {
  return (
    left.item.receivedAt.localeCompare(right.item.receivedAt) ||
    left.source.localeCompare(right.source) ||
    left.item.reference.localeCompare(right.item.reference)
  );
}

/**
 * Codes for one pass over the pending set. Assigning in age order keeps a code
 * stable for a notification that a reader has already seen: a newer arrival is
 * assigned last and can only take a code nobody older holds.
 */
function assignCodes(entries: readonly PendingNotification[]): CodedNotification[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const key = inboxId(entry.source, entry.item.reference);
    let length = CODE_LENGTH;
    let id = inboxCodeFor(key, length);
    while (used.has(id) && length < MAX_CODE_LENGTH) {
      length += 1;
      id = inboxCodeFor(key, length);
    }
    used.add(id);
    return { ...entry, id };
  });
}

export class AgentInbox {
  private readonly sources = new Map<string, InboxSource>();

  register(source: InboxSource): void {
    if (this.sources.has(source.name)) throw new Error(`Inbox source already registered: ${source.name}`);
    this.sources.set(source.name, source);
  }

  /** Reads what each source currently holds, reporting one failure without losing the rest. */
  private async collect(
    sources: readonly InboxSource[],
    sessionId: string,
  ): Promise<{
    pages: Array<{ source: string; items: InboxItem[]; remaining: number }>;
    entries: CodedNotification[];
    errors: Array<{ source: string; error: string }>;
  }> {
    const errors: Array<{ source: string; error: string }> = [];
    const pages = await Promise.all(
      sources.map(async (source) => {
        try {
          const page = await source.list(sessionId);
          return { source: source.name, items: page.items.filter((item) => item.state === 'unread'), remaining: page.remaining ?? 0 };
        } catch (error) {
          errors.push({ source: source.name, error: error instanceof Error ? error.message : String(error) });
          return { source: source.name, items: [] as InboxItem[], remaining: 0 };
        }
      }),
    );
    const entries = assignCodes(pages.flatMap((page) => page.items.map((item) => ({ source: page.source, item }))).sort(byAge));
    return { pages, entries, errors };
  }

  private select(request: InboxRequest): InboxSource[] {
    return [...this.sources.values()].filter((source) => !request.source || source.name === request.source);
  }

  async execute(request: InboxRequest, sessionId: string | undefined): Promise<unknown> {
    if (!sessionId) return { status: 'denied', error: 'The reading session could not be identified.' };
    if (request.source && !this.sources.has(request.source)) return { status: 'invalid', error: 'Unknown inbox source.' };
    const limit = request.limit ?? 20;
    const offset = request.offset ?? 0;
    if (request.action === 'read' && !request.ids?.length)
      return { status: 'invalid', error: 'read requires notification ids; call inbox with action list first.' };
    const { pages, entries, errors } = await this.collect(this.select(request), sessionId);
    if (request.action === 'list') {
      const page = entries.slice(offset, offset + limit);
      const total = entries.length + pages.reduce((sum, page) => sum + page.remaining, 0);
      return {
        type: 'inbox',
        status: errors.length ? 'partial' : 'ok',
        sources: pages.map((page) => ({
          source: page.source,
          count: page.items.length + page.remaining,
          unread: page.items.length,
        })),
        items: page.map(({ item, source, id }) => ({
          id,
          source,
          receivedAt: item.receivedAt,
          state: item.state,
          from: item.from,
          subject: item.subject,
        })),
        remaining: Math.max(0, total - offset - page.length),
        errors,
      };
    }
    // A code names a pending notification, so opening is resolved against the box
    // itself: an unknown code is reported as such and never guessed at.
    const byCode = new Map(entries.map((entry) => [entry.id, entry]));
    const grouped = new Map<InboxSource, string[]>();
    const unresolved: string[] = [];
    for (const id of request.ids ?? []) {
      const entry = byCode.get(id.trim().toUpperCase());
      if (!entry) {
        unresolved.push(id);
        continue;
      }
      const source = this.sources.get(entry.source);
      if (!source) continue;
      grouped.set(source, [...new Set([...(grouped.get(source) ?? []), entry.item.reference])]);
    }
    const opened: Array<{ id: string; source: string; content: unknown }> = [];
    // Deliveries are the facts about what the caller now holds. They travel
    // with the content, so the host can record the handover later without
    // having to recognise the content again.
    const deliveries: ToolDelivery[] = [];
    // Grouped reads keep each source's attachment and transaction limits intact.
    for (const [source, references] of grouped) {
      try {
        const results = await source.read(references, sessionId);
        for (const result of results) {
          opened.push({ id: inboxCodeFor(inboxId(source.name, result.reference)), source: source.name, content: result.content });
          if (result.delivery) deliveries.push(result.delivery);
        }
      } catch (error) {
        errors.push({ source: source.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!opened.length && !errors.length) return { status: 'invalid', error: 'Use a notification id returned by inbox.', unresolved };
    return {
      type: 'inbox',
      status: errors.length || unresolved.length ? 'partial' : 'ok',
      action: request.action,
      items: opened,
      ...(deliveries.length ? { [DELIVERIES_KEY]: deliveries } : {}),
      ...(unresolved.length ? { unresolved } : {}),
      errors,
    };
  }
}
