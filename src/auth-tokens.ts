import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from './paths.js';

/**
 * Long-lived credentials that admit a remote client to the daemon's TCP
 * listener. The host keeps only a per-token salt and a SHA-256 of
 * salt+token, so a stolen `auth-tokens.json` does not yield a usable token;
 * the plaintext exists exactly once, when `createAuthToken` prints it for the
 * owner to carry to the client. Verification is timing-safe and fails closed:
 * a missing or unreadable store admits nobody.
 */
export interface AuthTokenSummary {
  id: string;
  createdAt: string;
}

interface AuthTokenRecord {
  id: string;
  salt: string;
  hash: string;
  createdAt: string;
}

interface AuthTokenFile {
  version: 1;
  tokens: AuthTokenRecord[];
}

export function authTokensPath(): string {
  return getDataPath('auth-tokens.json');
}

function readStore(): AuthTokenFile {
  const path = authTokensPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tokens: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The auth token store at ${path} is not valid JSON. Fix or delete it to mint a new token.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`The auth token store at ${path} must be a JSON object.`);
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) throw new Error(`The auth token store at ${path} needs a "tokens" array.`);
  const records: AuthTokenRecord[] = [];
  for (const value of tokens) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`The auth token store at ${path} has a malformed token record.`);
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.salt !== 'string' ||
      typeof record.hash !== 'string' ||
      typeof record.createdAt !== 'string'
    )
      throw new Error(`The auth token store at ${path} has a malformed token record.`);
    records.push({ id: record.id, salt: record.salt, hash: record.hash, createdAt: record.createdAt });
  }
  return { version: 1, tokens: records };
}

function writeStore(store: AuthTokenFile): void {
  const path = authTokensPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function hashToken(salt: string, token: string): string {
  return createHash('sha256').update(salt, 'hex').update(token, 'utf8').digest('hex');
}

/** Mints a token, stores its salted hash, and returns the plaintext once. */
export function createAuthToken(): { id: string; token: string } {
  const id = randomBytes(8).toString('hex');
  const token = `obt_${randomBytes(24).toString('base64url')}`;
  const salt = randomBytes(16).toString('hex');
  const store = readStore();
  store.tokens.push({ id, salt, hash: hashToken(salt, token), createdAt: new Date().toISOString() });
  writeStore(store);
  return { id, token };
}

/** Timing-safe check against every minted token. Absent or broken store: false. */
export function verifyAuthToken(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const store = readStore();
  for (const record of store.tokens) {
    const candidate = Buffer.from(hashToken(record.salt, token), 'hex');
    const expected = Buffer.from(record.hash, 'hex');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** Ids and mint times only: the store never lists anything secret. */
export function listAuthTokens(): AuthTokenSummary[] {
  return readStore().tokens.map(({ id, createdAt }) => ({ id, createdAt }));
}

/** Removes one token. False when the id is not in the store. */
export function revokeAuthToken(id: string): boolean {
  const store = readStore();
  const kept = store.tokens.filter((record) => record.id !== id);
  if (kept.length === store.tokens.length) return false;
  store.tokens = kept;
  writeStore(store);
  return true;
}

/** Whether a store exists at all, for CLI status lines. */
export function authTokensExist(): boolean {
  return existsSync(authTokensPath());
}
