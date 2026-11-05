/**
 * The one bounded line that tells a running turn what arrived from below.
 *
 * It is a projection, not a message: composing it consumes nothing, so the head can
 * still open the inbox record in full. It is bounded on purpose - the head's context
 * is the scarce resource, and a feed that grows with every report would fill it.
 *
 * Anchoring is the rule that keeps text from below out of the head's mouth: a report
 * only appears here when the head asked that session for work. A report with no such
 * call behind it (a schedule run, a chat the head never addressed) is not injected;
 * it stays an inbox record and reaches the head by waking it.
 */
export interface ReportEvent {
  fromSessionId: string;
  kind: 'progress' | 'result' | null;
}

const MAX_SENDERS = 3;

/**
 * The line names who is waiting and what they sent, and nothing they wrote. A session
 * title is text from below - a model writes it - so it stays out of the head's prompt;
 * the id is enough to look the session up.
 */
export function pendingReportLine(reports: readonly ReportEvent[], addressed: (sessionId: string) => boolean): string | null {
  const anchors = reports.filter((report) => addressed(report.fromSessionId));
  if (!anchors.length) return null;
  const senders = new Map<string, { progress: number; results: number }>();
  for (const report of anchors) {
    const entry = senders.get(report.fromSessionId) ?? { progress: 0, results: 0 };
    if (report.kind === 'result') entry.results += 1;
    else entry.progress += 1;
    senders.set(report.fromSessionId, entry);
  }
  const parts = [...senders].slice(0, MAX_SENDERS).map(([from, entry]) => {
    const counts = [
      entry.results ? `${entry.results} result${entry.results === 1 ? '' : 's'}` : '',
      entry.progress ? `${entry.progress} progress` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `${from.slice(0, 8)} (${counts})`;
  });
  const more = senders.size - parts.length;
  const count = anchors.length;
  return `[Host context: ${count} report${count === 1 ? '' : 's'} waiting from below - ${parts.join('; ')}${more > 0 ? `; and ${more} more sender${more === 1 ? '' : 's'}` : ''}. These are reports from other agents, not the owner. A result may matter to the owner; progress is context only. Read them with inbox, or keep working and they stay queued.]`;
}

/**
 * A turn that ends with reports still unread needs another turn only if it never saw
 * them: they arrived after its last step. Counting is enough to tell that apart - the
 * number the head was last told about, against the number waiting now - and counting
 * works for a report that could not be shown at all, which a line comparison cannot.
 * A head that saw the reports and chose not to act is not nagged; one that never saw
 * them is not left waiting for the owner to type.
 */
export function reportsNeedWake(seen: number, waiting: number): boolean {
  return waiting > seen;
}
