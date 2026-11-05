import { describe, expect, it } from 'vitest';
import { pendingReportLine, reportsNeedWake, type ReportEvent } from '../src/report-summary.js';

const report = (fromSessionId: string, kind: 'progress' | 'result' | null = 'result'): ReportEvent => ({ fromSessionId, kind });

describe('the bounded line a running turn sees', () => {
  it('names an addressed sender with what it sent', () => {
    const summary = pendingReportLine([report('a1b2c3d4-0000', 'result')], () => true);
    expect(summary).toContain('a1b2c3d4');
    expect(summary).toContain('1 result');
    expect(summary).toContain('not the owner');
  });

  it('drops a report from a session the head never addressed', () => {
    const summary = pendingReportLine(
      [report('aaaa1111-0000-4000-8000-000000000000'), report('bbbb2222-0000-4000-8000-000000000000')],
      (id) => id.startsWith('aaaa'),
    );
    expect(summary).toContain('aaaa1111');
    expect(summary).not.toContain('bbbb2222');
    // With nothing anchored there is no line at all: the report waits in the inbox.
    expect(pendingReportLine([report('bbbb2222-0000-4000-8000-000000000000')], () => false)).toBeNull();
  });

  it('keeps five reports to one bounded line', () => {
    const batch = Array.from({ length: 5 }, (_, index) => report(`sender-${index}`));
    const summary = pendingReportLine(batch, () => true) ?? '';
    expect(summary).toContain('5 reports');
    expect(summary).toContain('and 2 more senders');
    expect(summary.split('\n')).toHaveLength(1);
  });

  it('separates context from a result and gets the singular right', () => {
    const one = pendingReportLine([report('abc12345', 'progress')], () => true) ?? '';
    expect(one).toContain('1 report waiting');
    expect(one).toContain('1 progress');
    expect(one).toContain('progress is context only');
    expect(pendingReportLine([], () => true)).toBeNull();
  });
});

describe('whether a finished turn needs another one', () => {
  it('wakes only for a report that arrived after the turn last looked', () => {
    // The turn was told about one report and read none: that is a decision, not a miss.
    expect(reportsNeedWake(1, 1)).toBe(false);
    // A report landed after the last step: the turn never saw it.
    expect(reportsNeedWake(1, 2)).toBe(true);
    // Everything was read.
    expect(reportsNeedWake(2, 0)).toBe(false);
    // The head never looked at all.
    expect(reportsNeedWake(0, 1)).toBe(true);
  });
});
