/**
 * What a tool handed to the session that called it.
 *
 * A tool result is a rendering for the model: it can be truncated, spilled to
 * disk or summarized, and the host must never have to guess what it means. A
 * delivery is the structured part of that result - the facts about what the
 * caller now holds - so the delivery path declares it and it travels in a
 * reserved slot that survives truncation.
 *
 * The contract is deliberately small and generic: the tool layer preserves it
 * without understanding it, and each domain (worker reports, team messages)
 * reads its own deliveries out of it.
 */
export interface ToolDelivery {
  /** Which kind of thing was delivered, e.g. 'worker'. */
  kind: string;
  /** The identity of the delivered thing, e.g. the worker session id. */
  id: string;
  /** The revision of the delivered record the caller now holds. */
  revision: number;
  /** How far the caller is caught up on the delivered record's own stream. */
  cursor?: number;
}

/**
 * The reserved key a tool result uses to declare its deliveries.
 *
 * It sits beside the rendered content rather than inside it, because the
 * content may be cut for size while a delivery may not: a receipt that
 * disappears together with a long report is a receipt that never happened.
 */
export const DELIVERIES_KEY = 'openbutlerDeliveries';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * One delivery, when the value is one.
 *
 * A malformed delivery is dropped rather than guessed at: a receipt that
 * cannot be read is not a receipt.
 */
export function deliveryOf(value: unknown): ToolDelivery | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  const id = value.id;
  const revision = value.revision;
  if (typeof kind !== 'string' || !kind) return undefined;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return undefined;
  const cursor = value.cursor;
  return {
    kind,
    id,
    revision,
    ...(typeof cursor === 'number' && Number.isFinite(cursor) ? { cursor } : {}),
  };
}

/**
 * The deliveries a tool result declares, or an empty list when it declares
 * none. Malformed entries are dropped rather than guessed at: a receipt that
 * cannot be read is not a receipt.
 */
export function deliveriesOf(value: unknown): ToolDelivery[] {
  if (!isRecord(value)) return [];
  const declared = value[DELIVERIES_KEY];
  if (!Array.isArray(declared)) return [];
  const deliveries: ToolDelivery[] = [];
  for (const entry of declared) {
    const delivery = deliveryOf(entry);
    if (delivery) deliveries.push(delivery);
  }
  return deliveries;
}
