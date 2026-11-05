import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataPath } from './paths.js';
import { isWithinPhysicalDirectory } from './workspace-scope.js';

/** One session owns its transcript and attachments in the same directory. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * The machine custodian is an internal session, not a chat. It lives at this
 * reserved id on every install, so the store, the chat picker, session pruning
 * and the cross-session registry recognize it by identity alone: no marker on
 * the record, no pointer in the ledger, nothing per-install, and no chat can
 * take its place by accident.
 */
export const CUSTODIAN_SESSION_ID = '00000000-0000-4000-8000-000000000000';
/**
 * The custodian's own active-context budget. It follows the identity above, not a
 * field on the record: a budget written onto a session is data that nothing in
 * the product can display or change, so it silently re-tunes that chat's
 * compaction. Every other session compacts against its model window.
 */
export const CUSTODIAN_CONTEXT_LIMIT_TOKENS = 200_000;
export const sessionsDirectory = () => getDataPath('sessions');
export function sessionDirectory(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  return join(sessionsDirectory(), id);
}
export const sessionFilePath = (id: string) => join(sessionDirectory(id), `${id}.json`);
export const sessionAttachmentsDirectory = (id: string) => join(sessionDirectory(id), 'attachments');
export function ensureSessionDirectory(id: string): string {
  const root = sessionsDirectory();
  mkdirSync(root, { recursive: true });
  const target = sessionDirectory(id);
  if (!isWithinPhysicalDirectory(target, root) || (existsSync(target) && lstatSync(target).isSymbolicLink()))
    throw new Error('Session directory escapes its storage root.');
  mkdirSync(target, { recursive: true });
  return target;
}
export function ensureSessionAttachmentsDirectory(id: string): string {
  const root = ensureSessionDirectory(id);
  const target = sessionAttachmentsDirectory(id);
  if (!isWithinPhysicalDirectory(target, root) || (existsSync(target) && lstatSync(target).isSymbolicLink()))
    throw new Error('Attachment directory escapes its session.');
  mkdirSync(target, { recursive: true });
  return target;
}
export function legacySessionFilePath(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  return join(sessionsDirectory(), `${id}.json`);
}
/** Old flat files are read only until the session is next saved in its directory. */
export function savedSessionFilePath(id: string): string {
  const current = sessionFilePath(id);
  return existsSync(current) ? current : legacySessionFilePath(id);
}
