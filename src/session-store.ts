import { TURN_SOURCES } from './communication.js';
import type { FileAttachment } from './attachments.js';
import type { SessionProject } from './projects/types.js';
import type { ReasoningSupport } from './provider/registry.js';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import {
  CUSTODIAN_CONTEXT_LIMIT_TOKENS,
  CUSTODIAN_SESSION_ID,
  SESSION_ID,
  sessionsDirectory,
  sessionDirectory,
  ensureSessionDirectory,
  sessionFilePath,
  savedSessionFilePath,
  legacySessionFilePath,
} from './session-paths.js';
import { isWithinPhysicalDirectory } from './workspace-scope.js';
import { appendTranscriptArchiveReference, repairQueuedMessageOrder, retireCoveredToolPreviews } from './conversation.js';
import type { TurnCompletion } from './turn-types.js';
import { writeSessionSnapshot } from './session-writer.js';

export type NoticeTone = 'info' | 'warn' | 'error';

/**
 * The single authority for user-entry sources. The type and the save
 * validator both derive from this list, so a new source can never be added to
 * one and forgotten in the other — the drift that once made every team-sourced
 * session unsavable.
 */
export const USER_ENTRY_SOURCES = TURN_SOURCES;
export type UserEntrySource = (typeof USER_ENTRY_SOURCES)[number];

/** Metadata every entry carries so a client can group and time the work. */
export interface SessionEntryMeta extends TurnCompletion {
  /** Epoch milliseconds when the entry was first written. */
  at?: number | undefined;
  /** Id of the user message that opened the turn this entry belongs to. */
  turnId?: string | undefined;
  /**
   * Provenance for text the machinery wrote rather than the conversation. A
   * compaction checkpoint is stored so the record stays complete, but the reader
   * is shown the compaction row instead of the raw summary.
   */
  internal?: 'compaction' | undefined;
}

export type SessionEntry = SessionEntryBody & SessionEntryMeta;

type SessionEntryBody =
  | {
      kind: 'user';
      text: string;
      workspaceRoot?: string;
      imageCount?: number;
      attachments?: FileAttachment[];
      source?: UserEntrySource;
      eventId?: string;
    }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'notice';
      text: string;
      detail?: string;
      tone?: NoticeTone;
      /**
       * Machine-readable reason this notice exists (e.g. `compaction:exceeds-window`),
       * set when an owner needs the kind of refusal without parsing prose. Absent on
       * every other notice: they are statements, not classified failures.
       */
      cause?: string;
    }
  | { kind: 'divider'; text?: string }
  | { kind: 'reasoning'; text: string; durationMs?: number }
  | {
      // Compaction is a visible event in the transcript: it changes how much
      // context the model can see, and a reader deserves to see when and how far.
      kind: 'compaction';
      status: 'running' | 'done' | 'failed';
      beforeTokens?: number;
      afterTokens?: number;
      durationMs?: number;
    }
  | {
      kind: 'tool';
      command?: string;
      /** Complete, redacted input for expanded tool details. */
      input?: Record<string, unknown>;
      result: string;
      running?: boolean;
      preparing?: boolean;
      tool?: string;
      toolTitle?: string;
      session?: string;
      durationMs?: number;
      outcome?: string;
    };

export interface SessionFileInfo {
  id: string;
  path: string;
  modifiedAt: number;
  sizeBytes: number;
}

export interface SavedSession {
  project?: SessionProject;
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When conversation content last changed - a message landed or a turn
   * completed. Recent lists order by this; opening or switching a chat never
   * rewrites it. Absent on sessions saved before this field existed; listing
   * falls back to `updatedAt` for those.
   */
  lastActivityAt?: string;
  providerId: string;
  modelId: string;
  /**
   * This session's own reasoning effort, written when the owner picks one in
   * this chat. Absent means the session follows the machine default
   * (settings.reasoning), so a recorded choice survives restarts and never
   * leaks into another session.
   */
  reasoning?: string;
  /** This session's reasoning-visibility toggle; absent means the machine default. */
  showReasoning?: boolean;
  /**
   * The effort levels this session's own model offers, written with the model
   * switch. A workspace runtime is shared, so it may already be bound to another
   * session's model; this keeps the chat's own picker honest about what the model
   * it reports can actually take.
   */
  reasoningVariants?: Array<{ id: string; label: string }>;
  /**
   * The model facts this session runs with, written with the model switch.
   * A workspace runtime is shared, so its capabilities describe whichever
   * model it is bound to; these describe the model THIS chat reports and
   * uses, so the chat stays correct while another chat runs another model.
   */
  supportsVision?: boolean;
  reasoningSupport?: ReasoningSupport;
  reasoningMetadataSource?: string | null;
  reasoningTitles?: boolean;
  /** Canonical workspace that supplied this session's tool and memory scope. */
  workspaceRoot?: string;
  contextTokens?: number;
  /** Byte estimate of the last provider-measured input, used only for subsequent growth. */
  contextEstimateTokens?: number;
  contextWindowTokens?: number;
  /** Opaque provider/key-pool ids mapped to the last selected key position. */
  keyPositions?: Record<string, number>;
  /**
   * Denormalised display fields, written so the picker never has to read `entries`.
   * Absent on sessions saved before this field existed; listing falls back to a full parse
   * for those and they gain the fields the next time they are saved.
   */
  hasUserMessage?: boolean;
  /** Owner stop/Esc policy survives host restarts; automatic events cannot release it. */
  automaticWakeHeld?: boolean;
  preview?: string;
  /**
   * Denormalised cross-session context fields, written so the session registry and the
   * "Recent sessions" block never parse `entries`. Absent on sessions saved before these
   * fields existed; the block degrades to title and preview until the session is saved again.
   */
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  entries: SessionEntry[];
  conversation: ModelMessage[];
  /** Full transcript retained across compaction; older sessions fall back to `conversation`. */
  conversationArchive?: ModelMessage[];
}

/**
 * A page of transcript entries addressed by absolute host index. A windowed
 * client holds only the tail, so it asks the host for the older range it does
 * not have; `from`/`to` are absolute and `total` is the full transcript length.
 */
export interface SessionEntriesRange {
  from: number;
  to: number;
  total: number;
  entries: SessionEntry[];
}

export interface SessionSummary {
  running?: boolean;
  project?: SessionProject;
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  /** Content-activity stamp used for ordering; see SavedSession.lastActivityAt. */
  lastActivityAt?: string;
  providerId: string;
  modelId: string;
  workspaceRoot?: string;
}

/**
 * The context window compaction budgets against for one session. A caller passes
 * the cap it owns - see `compactionContextWindowTokens` for the custodian's, taken
 * from its identity - and a session without one keeps the model window. Once
 * measured context has passed the cap the full window returns: compaction
 * cannot summarise down through a limit its own request would already exceed,
 * so an oversized chat keeps normal behaviour instead of failing at every step
 * boundary.
 */
export function effectiveContextWindowTokens(
  window: number | null,
  cap: number | undefined,
  measuredContextTokens: number | undefined,
): number | null {
  if (window === null || cap === undefined) return window;
  if (measuredContextTokens !== undefined && measuredContextTokens >= cap) return window;
  return Math.min(window, cap);
}

/**
 * The same decision for a real session, with the cap taken from identity (and the
 * owner's setting) rather than from the record. The custodian's budget is a function
 * of `CUSTODIAN_SESSION_ID` and the configured limit, and every chat compacts against
 * its own model window, so a stale or accidental field on a saved record cannot
 * re-tune a conversation.
 */
export function compactionContextWindowTokens(
  sessionId: string,
  window: number | null,
  measuredContextTokens: number | undefined,
  configuredLimit?: number,
): number | null {
  const cap = sessionId === CUSTODIAN_SESSION_ID ? (configuredLimit ?? CUSTODIAN_CONTEXT_LIMIT_TOKENS) : undefined;
  return effectiveContextWindowTokens(window, cap, measuredContextTokens);
}

export function createSession(providerId: string, modelId: string, contextWindowTokens?: number, workspaceRoot?: string): SavedSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    keyPositions: {},
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    providerId,
    modelId,
    ...(workspaceRoot ? { workspaceRoot: resolve(workspaceRoot) } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    entries: [],
    conversation: [],
  };
}

export function sessionTitle(entries: readonly SessionEntry[]): string {
  const firstUser = entries.find((entry) => entry.kind === 'user');
  if (!firstUser || firstUser.kind !== 'user') return 'New session';
  const title = firstUser.text.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 80) : firstUser.imageCount ? 'Image chat' : 'New session';
}

/** Session files on disk with their metadata, oldest first; used by explicit pruning only. */
export function listSessionFiles(): SessionFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDirectory());
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const candidates = new Map<string, string>();
  for (const name of names) {
    if (SESSION_ID.test(name)) {
      try {
        if (lstatSync(sessionDirectory(name)).isDirectory() && isWithinPhysicalDirectory(sessionDirectory(name), sessionsDirectory()))
          candidates.set(name, sessionFilePath(name));
      } catch {
        /* A disappearing session directory is ignored. */
      }
    } else if (name.endsWith('.json') && SESSION_ID.test(name.slice(0, -5)) && !candidates.has(name.slice(0, -5))) {
      const id = name.slice(0, -5);
      candidates.set(id, savedSessionFilePath(id));
    }
  }
  const files: SessionFileInfo[] = [];
  for (const [id, candidate] of candidates) {
    try {
      let path = candidate;
      try {
        statSync(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        path = legacySessionFilePath(id);
      }
      const details = statSync(path);
      if (details.isFile() && !lstatSync(path).isSymbolicLink() && isWithinPhysicalDirectory(path, sessionsDirectory()))
        files.push({ id, path, modifiedAt: details.mtimeMs, sizeBytes: details.size });
    } catch {
      /* A partial or unreadable session cannot block the registry. */
    }
  }
  return files.sort((left, right) => left.modifiedAt - right.modifiedAt || left.id.localeCompare(right.id));
}

/** Called only by explicit session pruning; the transcript and its files share one lifetime. */
export function removeSavedSession(id: string): void {
  if (id === CUSTODIAN_SESSION_ID) throw new Error('Refusing to remove the machine custodian.');
  const directory = sessionDirectory(id);
  if (existsSync(directory)) {
    if (lstatSync(directory).isSymbolicLink() || !isWithinPhysicalDirectory(directory, sessionsDirectory()))
      throw new Error('Refusing to remove a session outside its storage root.');
    rmSync(directory, { recursive: true, force: true });
  }
  rmSync(legacySessionFilePath(id), { force: true });
}

/**
 * Chats the owner can open. The machine custodian is an internal session, not a
 * chat: it is recognized by its reserved id and never appears here.
 */
export function listSavedSessions(workspaceRoot?: string | null): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  for (const file of listSessionFiles()) {
    const id = file.id;
    if (id === CUSTODIAN_SESSION_ID) continue;
    try {
      const session = readSessionHeader(file.path, id);
      if (!session || session.id !== id || !session.hasUserMessage) continue;
      if (workspaceRoot === null && session.workspaceRoot) continue;
      if (typeof workspaceRoot === 'string' && (!session.workspaceRoot || !samePath(session.workspaceRoot, workspaceRoot))) continue;
      sessions.push({
        id,
        title: session.title,
        preview: session.preview ?? '',
        updatedAt: session.updatedAt,
        ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
        providerId: session.providerId,
        modelId: session.modelId,
        ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
        ...(session.project ? { project: session.project } : {}),
      });
    } catch {
      // Ignore an incomplete or unreadable file so one damaged session cannot block the picker.
    }
  }

  return sessions.sort(
    (left, right) =>
      (right.lastActivityAt ?? right.updatedAt).localeCompare(left.lastActivityAt ?? left.updatedAt) || left.id.localeCompare(right.id),
  );
}

/**
 * A session file stores its display entries plus the model transcript and, once a compaction
 * has happened, the whole pre-compaction archive. A tool result alone can be 80 KB, so those two
 * fields are nearly all of the bytes and the picker needs none of them. Listing therefore reads
 * only the part of the file in front of them.
 *
 * The cutoff is guessed and then verified: the truncated prefix is only accepted if it parses as a
 * session whose id matches the file name. A string inside an entry that happens to contain
 * `\n  "conversation":` cannot pass that check, so the stream scan below is what keeps this
 * correct rather than merely fast.
 */
/**
 * The display fields the picker, the session registry, and the "Recent sessions" block show.
 * `entries` is absent: none of them read it. The message previews are denormalised onto the saved
 * session so this stays true — reading them from `entries` would otherwise mean parsing every
 * session on every listing or context build.
 */
export interface StoredSessionHeader {
  project?: SessionProject;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  providerId: string;
  modelId: string;
  workspaceRoot?: string;
  hasUserMessage: boolean;
  preview: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
}

function sessionPreview(entries: readonly SessionEntry[]): string {
  const lastUser = entries.findLast((entry) => entry.kind === 'user');
  if (lastUser?.kind !== 'user') return '';
  return lastUser.text.replace(/\s+/g, ' ').trim().slice(0, 120) || (lastUser.imageCount ? '[Image attached #1]' : '');
}

function firstUserMessageText(entries: readonly SessionEntry[]): string {
  const firstUser = entries.find((entry) => entry.kind === 'user');
  if (firstUser?.kind !== 'user') return '';
  return firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 240) || (firstUser.imageCount ? '[Image attached]' : '');
}

function lastAssistantMessageText(entries: readonly SessionEntry[]): string {
  const lastAssistant = entries.findLast((entry) => entry.kind === 'assistant');
  if (lastAssistant?.kind !== 'assistant') return '';
  return lastAssistant.text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Reads a session's display fields without reading its entries.
 *
 * A saved session is pretty-printed with two-space indentation and every header field is
 * serialised before `entries`, so the header alone is a few hundred bytes at the front of the file.
 * A JSON string can never contain a real newline, so `\n  "entries":` occurs only at a structural
 * position: cutting there and closing the object cannot produce a valid parse by accident. That
 * makes the cutoff checkable rather than merely plausible — anything unexpected falls through to a
 * bounded stream scan, which is what keeps this correct and not just fast.
 *
 * Sessions saved before `hasUserMessage` and `preview` existed carry no header-only summary, so
 * the stream scan reads their previews from `entries` without materialising them; they are
 * rewritten with both fields the next time they are saved.
 */
const HEADER_WINDOW_BYTES = 8 * 1024;

export function readSessionHeader(path: string, id: string): StoredSessionHeader | null {
  const head = readPrefix(path, HEADER_WINDOW_BYTES);
  if (head === null) return null;
  const boundary = /\n {2}"entries":/.exec(head.text);
  if (boundary) {
    // Pretty-printed JSON puts the separating comma at the end of the prefix, so it has to go
    // before the closing brace is added back.
    const parsed = tryParseHeader(`${head.text.slice(0, boundary.index).replace(/[\s,]+$/, '')}\n}`, id);
    if (parsed) return parsed;
  } else if (head.complete) {
    // The whole file fits in the window and carries no `entries` marker, so it is already complete.
    return fullSessionHeader(head.text);
  }
  return scanSessionHeader(path, id);
}

/**
 * Reads at most `bytes` from the front of a file. Session headers are a few hundred bytes.
 *
 * `complete` reports that the read reached end of file. It cannot be inferred from the text length,
 * because the prefix is measured in bytes while the string is measured in characters and a multibyte
 * (e.g. CJK) header decodes to fewer of them.
 */
function readPrefix(path: string, bytes: number): { text: string; complete: boolean } | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return { text: buffer.toString('utf8', 0, read), complete: read < bytes };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fullSessionHeader(text: string): StoredSessionHeader | null {
  const full = parseSession(text);
  if (!full) return null;
  return {
    id: full.id,
    title: full.title,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    ...(full.lastActivityAt ? { lastActivityAt: full.lastActivityAt } : {}),
    providerId: full.providerId,
    modelId: full.modelId,
    ...(full.workspaceRoot ? { workspaceRoot: full.workspaceRoot } : {}),
    ...(full.project ? { project: full.project } : {}),
    hasUserMessage: full.hasUserMessage ?? full.entries.some((entry) => entry.kind === 'user'),
    preview: full.preview ?? sessionPreview(full.entries),
    firstUserMessage: full.firstUserMessage ?? firstUserMessageText(full.entries),
    lastAssistantMessage: full.lastAssistantMessage ?? lastAssistantMessageText(full.entries),
  };
}

/**
 * Streams a session file for the same summary `fullSessionHeader` returns, without ever
 * materialising `entries` or `conversation`. The old fallback read the whole file and parsed
 * it end to end, so one multi-megabyte legacy session cost a full allocation on every listing
 * and could exhaust the process under commit pressure. This scan instead walks the top level
 * in 32 KB chunks: header scalars are kept (bounded), `entries` items are examined one at a
 * time for the message previews, and every other value is skipped without being decoded.
 * Previews are normalised with the same whitespace-collapse-then-slice rule as
 * `sessionPreview`/`firstUserMessageText`/`lastAssistantMessageText`, applied on the fly so
 * retained text stays bounded however long the original was.
 */
function scanSessionHeader(path: string, id: string): StoredSessionHeader | null {
  type EntryDigest = {
    kind: string | null;
    textNorm: string | null;
    imageCount: number | null;
  };

  const headerCap = 16_384;
  const textCap = 240;
  const scrubCap = 8_192;

  let buffer = '';
  let pos = 0;
  let eof = false;
  let overflow = false;
  let descriptor: number | undefined;

  const chunk = Buffer.allocUnsafe(32 * 1024);

  function fill(): boolean {
    if (pos < buffer.length) return true;
    if (eof) return false;
    if (descriptor === undefined) return false;
    buffer = '';
    pos = 0;
    const read = readSync(descriptor, chunk, 0, chunk.length, null);
    if (read <= 0) {
      eof = true;
      return false;
    }
    buffer = chunk.toString('utf8', 0, read);
    if (read < chunk.length) eof = true;
    return true;
  }

  function peek(): string | null {
    if (pos >= buffer.length && !fill()) return null;
    return buffer[pos] ?? null;
  }

  function next(): string | null {
    if (pos >= buffer.length && !fill()) return null;
    return buffer[pos++] ?? null;
  }

  function skipWs(): void {
    for (;;) {
      const ch = peek();
      if (ch !== null && (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t')) pos++;
      else return;
    }
  }

  function expect(ch: string): void {
    if (next() !== ch) throw new Error(`expected ${ch}`);
  }

  function readUnicodeEscape(): string {
    let code = 0;
    for (let i = 0; i < 4; i++) {
      const ch = next();
      if (ch === null) throw new Error('truncated escape');
      const digit = parseInt(ch, 16);
      if (Number.isNaN(digit)) throw new Error('bad escape');
      code = code * 16 + digit;
    }
    return String.fromCharCode(code);
  }

  /** Consumes one string character (decoded) without storing it. Caller positions at the opening quote for the first char. */
  function nextStringChar(): string {
    const ch = next();
    if (ch === null) throw new Error('unterminated string');
    if (ch !== '\\') return ch;
    const esc = next();
    if (esc === null) throw new Error('unterminated escape');
    switch (esc) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return readUnicodeEscape();
      default:
        throw new Error('bad escape');
    }
  }

  /** Reads a string, retaining at most `cap` decoded chars; beyond that the scan is abandoned. */
  function readRetained(cap: number): string {
    expect('"');
    let out = '';
    for (;;) {
      const ch = peek();
      if (ch === null) throw new Error('unterminated string');
      if (ch === '"') {
        pos++;
        return out;
      }
      const decoded = nextStringChar();
      if (out.length < cap) out += decoded;
      else overflow = true;
    }
  }

  /** Reads a string with `sessionPreview` normalisation: collapse whitespace, trim, slice. */
  function readNormalized(): string {
    expect('"');
    let out = '';
    let pendingSpace = false;
    for (;;) {
      const ch = peek();
      if (ch === null) throw new Error('unterminated string');
      if (ch === '"') {
        pos++;
        return out;
      }
      const decoded = nextStringChar();
      if (/\s/.test(decoded)) {
        if (out.length > 0) pendingSpace = true;
      } else {
        if (pendingSpace) {
          if (out.length < textCap) out += ' ';
          pendingSpace = false;
        }
        if (out.length < textCap) out += decoded;
      }
    }
  }

  function readNumber(): number {
    let text = '';
    for (;;) {
      const ch = peek();
      if (ch !== null && /[-+0-9.eE]/.test(ch)) {
        text += ch;
        pos++;
      } else break;
    }
    const value = Number(text);
    if (text === '' || Number.isNaN(value)) throw new Error('bad number');
    return value;
  }

  function readLiteral(literal: string): void {
    for (let i = 0; i < literal.length; i++) {
      if (next() !== literal[i]) throw new Error('bad literal');
    }
  }

  function skipValue(depth: number): void {
    if (depth > 64) throw new Error('too deep');
    skipWs();
    const ch = peek();
    if (ch === '"') {
      expect('"');
      for (;;) {
        const c = peek();
        if (c === null) throw new Error('unterminated string');
        if (c === '"') {
          pos++;
          return;
        }
        nextStringChar();
      }
    }
    if (ch === '{') {
      pos++;
      skipWs();
      if (peek() === '}') {
        pos++;
        return;
      }
      for (;;) {
        skipWs();
        skipValue(depth + 1); // key
        skipWs();
        expect(':');
        skipValue(depth + 1);
        skipWs();
        const sep = next();
        if (sep === '}') return;
        if (sep !== ',') throw new Error('bad object');
      }
    }
    if (ch === '[') {
      pos++;
      skipWs();
      if (peek() === ']') {
        pos++;
        return;
      }
      for (;;) {
        skipValue(depth + 1);
        skipWs();
        const sep = next();
        if (sep === ']') return;
        if (sep !== ',') throw new Error('bad array');
      }
    }
    if (ch === 't') return readLiteral('true');
    if (ch === 'f') return readLiteral('false');
    if (ch === 'n') return readLiteral('null');
    readNumber();
  }

  /** Parses a small value (the `project` block) with bounded strings, for validation only. */
  function parseSmallValue(depth: number): unknown {
    if (depth > 8) throw new Error('too deep');
    skipWs();
    const ch = peek();
    if (ch === '"') return readRetained(scrubCap);
    if (ch === '{') {
      pos++;
      const obj: Record<string, unknown> = {};
      skipWs();
      if (peek() === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        skipWs();
        const key = readRetained(scrubCap);
        skipWs();
        expect(':');
        obj[key] = parseSmallValue(depth + 1);
        skipWs();
        const sep = next();
        if (sep === '}') return obj;
        if (sep !== ',') throw new Error('bad object');
      }
    }
    if (ch === '[') {
      pos++;
      const arr: unknown[] = [];
      skipWs();
      if (peek() === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseSmallValue(depth + 1));
        skipWs();
        const sep = next();
        if (sep === ']') return arr;
        if (sep !== ',') throw new Error('bad array');
      }
    }
    if (ch === 't') {
      readLiteral('true');
      return true;
    }
    if (ch === 'f') {
      readLiteral('false');
      return false;
    }
    if (ch === 'n') {
      readLiteral('null');
      return null;
    }
    return readNumber();
  }

  function readEntryDigest(): EntryDigest {
    const digest: EntryDigest = { kind: null, textNorm: null, imageCount: null };
    skipWs();
    if (peek() !== '{') {
      skipValue(0);
      return digest;
    }
    pos++;
    skipWs();
    if (peek() === '}') {
      pos++;
      return digest;
    }
    for (;;) {
      skipWs();
      const key = readRetained(scrubCap);
      skipWs();
      expect(':');
      skipWs();
      if (key === 'kind' && peek() === '"') digest.kind = readRetained(scrubCap);
      else if (key === 'text' && digest.kind !== null && (digest.kind === 'user' || digest.kind === 'assistant') && peek() === '"')
        digest.textNorm = readNormalized();
      else if (key === 'imageCount') digest.imageCount = readNumber();
      else skipValue(0);
      skipWs();
      const sep = next();
      if (sep === '}') return digest;
      if (sep !== ',') throw new Error('bad entry');
    }
  }

  const header: Record<string, unknown> = {};
  let entriesSeen = false;
  let anyUser = false;
  let firstUserNorm: string | null = null;
  let firstUserImage: number | null = null;
  let lastUserNorm: string | null = null;
  let lastUserImage: number | null = null;
  let lastAssistantNorm: string | null = null;

  try {
    descriptor = openSync(path, 'r');
    skipWs();
    expect('{');
    skipWs();
    if (peek() === '}') return null;
    for (;;) {
      skipWs();
      const key = readRetained(scrubCap);
      skipWs();
      expect(':');
      skipWs();
      switch (key) {
        case 'entries': {
          entriesSeen = true;
          expect('[');
          skipWs();
          if (peek() === ']') pos++;
          else {
            for (;;) {
              const digest = readEntryDigest();
              if (digest.kind === 'user') {
                anyUser = true;
                if (firstUserNorm === null) {
                  firstUserNorm = digest.textNorm ?? '';
                  firstUserImage = digest.imageCount;
                }
                lastUserNorm = digest.textNorm ?? '';
                lastUserImage = digest.imageCount;
              } else if (digest.kind === 'assistant') {
                lastAssistantNorm = digest.textNorm ?? '';
              }
              skipWs();
              const sep = next();
              if (sep === ']') break;
              if (sep !== ',') throw new Error('bad entries');
            }
          }
          break;
        }
        case 'project':
          header.project = parseSmallValue(0);
          break;
        case 'version':
          header.version = readNumber();
          break;
        case 'hasUserMessage': {
          skipWs();
          if (peek() === 't') {
            readLiteral('true');
            header.hasUserMessage = true;
          } else if (peek() === 'f') {
            readLiteral('false');
            header.hasUserMessage = false;
          } else return null;
          break;
        }
        case 'preview':
        case 'firstUserMessage':
        case 'lastAssistantMessage':
        case 'id':
        case 'title':
        case 'createdAt':
        case 'updatedAt':
        case 'lastActivityAt':
        case 'providerId':
        case 'modelId':
        case 'workspaceRoot':
          if (peek() !== '"') return null;
          header[key] = readRetained(headerCap);
          break;
        default:
          skipValue(0);
          break;
      }
      if (overflow) return null;
      skipWs();
      const sep = next();
      if (sep === '}') break;
      if (sep !== ',') throw new Error('bad session object');
    }
    while (peek() !== null) {
      // Trailing whitespace only; anything else is not a session file.
      const ch = next();
      if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') return null;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  if (!entriesSeen || header.version !== 1 || header.id !== id) return null;
  if (
    typeof header.title !== 'string' ||
    typeof header.createdAt !== 'string' ||
    typeof header.updatedAt !== 'string' ||
    typeof header.providerId !== 'string' ||
    typeof header.modelId !== 'string'
  )
    return null;
  if (header.project !== undefined && !isSessionProject(header.project)) return null;

  const firstUser = firstUserNorm ?? '';
  const lastUser = lastUserNorm ?? '';
  return {
    id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    ...(typeof header.lastActivityAt === 'string' ? { lastActivityAt: header.lastActivityAt } : {}),
    providerId: header.providerId,
    modelId: header.modelId,
    ...(typeof header.workspaceRoot === 'string' ? { workspaceRoot: header.workspaceRoot } : {}),
    ...(isSessionProject(header.project) ? { project: header.project } : {}),
    hasUserMessage: typeof header.hasUserMessage === 'boolean' ? header.hasUserMessage : anyUser,
    preview: typeof header.preview === 'string' ? header.preview : lastUser.slice(0, 120) || (lastUserImage ? '[Image attached #1]' : ''),
    firstUserMessage:
      typeof header.firstUserMessage === 'string' ? header.firstUserMessage : firstUser || (firstUserImage ? '[Image attached]' : ''),
    lastAssistantMessage: typeof header.lastAssistantMessage === 'string' ? header.lastAssistantMessage : (lastAssistantNorm ?? ''),
  };
}

function tryParseHeader(text: string, id: string): StoredSessionHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || value.id !== id) return null;
  if (typeof value.title !== 'string' || typeof value.updatedAt !== 'string' || typeof value.createdAt !== 'string') return null;
  if (typeof value.providerId !== 'string' || typeof value.modelId !== 'string') return null;
  // A session without both denormalised fields predates them, so the bounded
  // stream scan answers for it instead of a whole-file parse.
  if (value.hasUserMessage !== true || typeof value.preview !== 'string') return null;
  if (value.project !== undefined && !isSessionProject(value.project)) return null;
  return {
    id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastActivityAt === 'string' ? { lastActivityAt: value.lastActivityAt } : {}),
    providerId: value.providerId,
    modelId: value.modelId,
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(isSessionProject(value.project) ? { project: value.project } : {}),
    hasUserMessage: true,
    preview: value.preview,
    firstUserMessage: typeof value.firstUserMessage === 'string' ? value.firstUserMessage : '',
    lastAssistantMessage: typeof value.lastAssistantMessage === 'string' ? value.lastAssistantMessage : '',
  };
}

/**
 * A saved session a chat may open in this workspace. Identity is the id: a chat belongs to the
 * machine and carries no workspace stamp, while an isolated run carries the workspace it was
 * recorded in. Either way the record is addressable here when it belongs to this workspace or
 * to no single one.
 */
export function loadSessionForChat(id: string, workspaceRoot: string): SavedSession | null {
  const session = loadSavedSession(id);
  if (!session) return null;
  return !session.workspaceRoot || samePath(session.workspaceRoot, workspaceRoot) ? session : null;
}

export function loadSavedSession(id: string, workspaceRoot?: string | null): SavedSession | null {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  let text: string;
  try {
    const path = savedSessionFilePath(id);
    if (lstatSync(path).isSymbolicLink() || !isWithinPhysicalDirectory(path, sessionsDirectory()))
      throw new Error('Invalid session storage path.');
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const session = parseSession(text);
  if (!session || session.id !== id) throw new Error('This session file is invalid or unsupported.');
  if (workspaceRoot === null && session.workspaceRoot) return null;
  if (typeof workspaceRoot === 'string' && (!session.workspaceRoot || !samePath(session.workspaceRoot, workspaceRoot))) return null;
  const ordered = repairQueuedMessageOrder(session.conversation);
  const projected = retireCoveredToolPreviews(ordered);
  const restored: SavedSession = {
    ...session,
    conversation: projected,
    ...(session.conversationArchive ? { conversationArchive: repairQueuedMessageOrder(session.conversationArchive) } : {}),
    entries: session.entries.map((entry) => {
      if (entry.kind !== 'tool') return entry;
      if (entry.running) return { ...entry, running: false, result: 'Execution was interrupted before the result was saved.' };
      if (entry.preparing) return { ...entry, preparing: false, result: 'The tool call was not executed.' };
      return entry;
    }),
  };
  if (projected !== ordered) {
    restored.conversationArchive ??= ordered;
    const checkpoint = restored.conversation[0];
    if (checkpoint?.role === 'assistant' && typeof checkpoint.content === 'string') {
      restored.conversation = [
        { ...checkpoint, content: appendTranscriptArchiveReference(checkpoint.content, savedSessionFilePath(session.id)) },
        ...restored.conversation.slice(1),
      ];
    }
    delete restored.contextTokens;
    delete restored.contextEstimateTokens;
  }
  return restored;
}

function prepareSessionSave(session: SavedSession, options: { allowEmpty?: boolean } = {}): SavedSession | null {
  if (!isSavedSession(session)) throw new Error('Cannot save an invalid session.');
  const hasUserMessage = session.entries.some((entry) => entry.kind === 'user');
  if (!hasUserMessage && !options.allowEmpty) return null;
  // Built field by field rather than spread, because the listing reads a header from the front of
  // the file and needs `hasUserMessage` and `preview` to be serialised before `entries`. A spread
  // would append any key the incoming session does not already carry to the very end of the object,
  // which is exactly where they must not be.
  const saved: SavedSession = {
    version: 1,
    id: session.id,
    ...(session.keyPositions === undefined ? {} : { keyPositions: session.keyPositions }),
    title: session.title === 'New session' ? sessionTitle(session.entries) : session.title,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    ...(session.lastActivityAt === undefined ? {} : { lastActivityAt: session.lastActivityAt }),
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.reasoning === undefined ? {} : { reasoning: session.reasoning }),
    ...(session.showReasoning === undefined ? {} : { showReasoning: session.showReasoning }),
    ...(session.reasoningVariants === undefined ? {} : { reasoningVariants: session.reasoningVariants }),
    ...(session.supportsVision === undefined ? {} : { supportsVision: session.supportsVision }),
    ...(session.reasoningSupport === undefined ? {} : { reasoningSupport: session.reasoningSupport }),
    ...(session.reasoningMetadataSource === undefined ? {} : { reasoningMetadataSource: session.reasoningMetadataSource }),
    ...(session.reasoningTitles === undefined ? {} : { reasoningTitles: session.reasoningTitles }),
    ...(session.workspaceRoot === undefined ? {} : { workspaceRoot: session.workspaceRoot }),
    ...(session.project === undefined ? {} : { project: session.project }),
    ...(session.contextTokens === undefined ? {} : { contextTokens: session.contextTokens }),
    ...(session.contextEstimateTokens === undefined ? {} : { contextEstimateTokens: session.contextEstimateTokens }),
    ...(session.contextWindowTokens === undefined ? {} : { contextWindowTokens: session.contextWindowTokens }),
    hasUserMessage,
    ...(session.automaticWakeHeld === undefined ? {} : { automaticWakeHeld: session.automaticWakeHeld }),
    preview: sessionPreview(session.entries),
    firstUserMessage: firstUserMessageText(session.entries),
    lastAssistantMessage: lastAssistantMessageText(session.entries),
    entries: session.entries,
    conversation: session.conversation,
    ...(session.conversationArchive === undefined ? {} : { conversationArchive: session.conversationArchive }),
  };
  return saved;
}

export function saveSession(session: SavedSession, options: { allowEmpty?: boolean } = {}): SavedSession {
  const saved = prepareSessionSave(session, options);
  if (!saved) return session;
  ensureSessionDirectory(saved.id);
  const path = sessionFilePath(saved.id);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
  return saved;
}

export async function saveSessionAsync(session: SavedSession, options: { allowEmpty?: boolean } = {}): Promise<SavedSession> {
  const saved = prepareSessionSave(session, options);
  if (!saved) return session;
  ensureSessionDirectory(saved.id);
  await writeSessionSnapshot(sessionFilePath(saved.id), saved);
  return saved;
}

function parseSession(text: string): SavedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isSavedSession(value) ? value : null;
}

function isSessionProject(value: unknown): value is SessionProject {
  if (
    !isRecord(value) ||
    typeof value.locked !== 'boolean' ||
    typeof value.workspaceRoot !== 'string' ||
    !isAbsolute(value.workspaceRoot) ||
    !Array.isArray(value.folders)
  )
    return false;
  if (value.id === null) return value.name === null && value.folders.length === 0;
  return (
    typeof value.id === 'string' &&
    SESSION_ID.test(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 80 &&
    value.folders.length > 0 &&
    value.folders.length <= 16 &&
    value.folders.every((folder) => typeof folder === 'string' && isAbsolute(folder)) &&
    value.folders[0] === value.workspaceRoot
  );
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    SESSION_ID.test(value.id) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastActivityAt === undefined || typeof value.lastActivityAt === 'string') &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    (value.reasoning === undefined || (typeof value.reasoning === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.reasoning))) &&
    (value.showReasoning === undefined || typeof value.showReasoning === 'boolean') &&
    (value.reasoningVariants === undefined ||
      (Array.isArray(value.reasoningVariants) &&
        value.reasoningVariants.every(
          (variant) => isRecord(variant) && typeof variant.id === 'string' && typeof variant.label === 'string',
        ))) &&
    (value.supportsVision === undefined || typeof value.supportsVision === 'boolean') &&
    (value.reasoningSupport === undefined ||
      value.reasoningSupport === 'available' ||
      value.reasoningSupport === 'model-unsupported' ||
      value.reasoningSupport === 'adapter-unmapped') &&
    (value.reasoningMetadataSource === undefined ||
      value.reasoningMetadataSource === null ||
      typeof value.reasoningMetadataSource === 'string') &&
    (value.reasoningTitles === undefined || typeof value.reasoningTitles === 'boolean') &&
    (value.keyPositions === undefined ||
      (isRecord(value.keyPositions) &&
        Object.entries(value.keyPositions).every(
          ([pool, position]) =>
            /^[a-f0-9]{64}$/.test(pool) && typeof position === 'number' && Number.isSafeInteger(position) && position >= 0,
        ))) &&
    (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string') &&
    (value.project === undefined || isSessionProject(value.project)) &&
    (value.contextTokens === undefined ||
      (typeof value.contextTokens === 'number' && Number.isSafeInteger(value.contextTokens) && value.contextTokens >= 0)) &&
    (value.contextEstimateTokens === undefined ||
      (typeof value.contextEstimateTokens === 'number' &&
        Number.isSafeInteger(value.contextEstimateTokens) &&
        value.contextEstimateTokens >= 0)) &&
    (value.contextWindowTokens === undefined ||
      (typeof value.contextWindowTokens === 'number' &&
        Number.isSafeInteger(value.contextWindowTokens) &&
        value.contextWindowTokens > 0)) &&
    Array.isArray(value.entries) &&
    value.entries.every(isSessionEntry) &&
    Array.isArray(value.conversation) &&
    value.conversation.every(isModelMessage) &&
    (value.conversationArchive === undefined ||
      (Array.isArray(value.conversationArchive) && value.conversationArchive.every(isModelMessage))) &&
    (value.firstUserMessage === undefined || typeof value.firstUserMessage === 'string') &&
    (value.lastAssistantMessage === undefined || typeof value.lastAssistantMessage === 'string')
  );
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) return false;
  if (value.kind === 'tool')
    return (
      (typeof value.command === 'string' || (isRecord(value.input) && typeof value.tool === 'string')) &&
      (value.input === undefined || isRecord(value.input)) &&
      typeof value.result === 'string' &&
      (value.running === undefined || typeof value.running === 'boolean') &&
      (value.preparing === undefined || typeof value.preparing === 'boolean') &&
      (value.tool === undefined || typeof value.tool === 'string') &&
      (value.toolTitle === undefined || typeof value.toolTitle === 'string') &&
      (value.session === undefined || typeof value.session === 'string')
    );
  if (value.kind === 'user')
    return (
      typeof value.text === 'string' &&
      (value.source === undefined || (USER_ENTRY_SOURCES as readonly string[]).includes(String(value.source))) &&
      (value.eventId === undefined || typeof value.eventId === 'string') &&
      (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string') &&
      (value.imageCount === undefined ||
        (typeof value.imageCount === 'number' && Number.isSafeInteger(value.imageCount) && value.imageCount > 0))
    );
  if (value.kind === 'compaction')
    return (
      ['running', 'done', 'failed'].includes(String(value.status)) &&
      (value.beforeTokens === undefined ||
        (typeof value.beforeTokens === 'number' && Number.isSafeInteger(value.beforeTokens) && value.beforeTokens >= 0)) &&
      (value.afterTokens === undefined ||
        (typeof value.afterTokens === 'number' && Number.isSafeInteger(value.afterTokens) && value.afterTokens >= 0))
    );
  if (value.kind === 'divider')
    // A day divider carries only its moment; a statement divider carries words.
    return value.text === undefined || typeof value.text === 'string';
  return (
    ['assistant', 'notice', 'reasoning'].includes(String(value.kind)) &&
    typeof value.text === 'string' &&
    (value.internal === undefined || value.internal === 'compaction') &&
    // A reasoning entry may carry how long the model thought, so the transcript
    // can show "Thought for 13.2s" instead of an unlabelled block.
    (value.kind !== 'reasoning' ||
      value.durationMs === undefined ||
      (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0))
  );
}

function isModelMessage(value: unknown): value is ModelMessage {
  return isRecord(value) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(String(value.role)) && 'content' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export function samePath(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLocaleLowerCase('en-US') === rightPath.toLocaleLowerCase('en-US')
    : leftPath === rightPath;
}
