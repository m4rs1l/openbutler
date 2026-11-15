import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source and stylesheet pins live in the root program: the web tsconfig
// declares no node types (same pattern as tests/web/message-actions-stylesheet.test.ts).
function source(relative: string): string {
  return readFileSync(relative, 'utf8');
}

describe('chat page soft transitions and dock gap', () => {
  it('collapses the dock top padding so the chat meets the composer with no white strip', () => {
    const styles = source('web/src/styles.css');
    const dockRules = [...styles.matchAll(/\.action-dock\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(dockRules).toHaveLength(2);
    // Desktop: side padding centers the 760px column, top padding is gone.
    expect(dockRules[0]).toContain('padding: 0 24px 12px');
    expect(dockRules[0]).not.toContain('8px 24px 12px');
    // Mobile keeps the bottom safe-area share (home indicator), loses the top gap.
    expect(dockRules[1]).toContain('padding: 0 12px max(8px, env(safe-area-inset-bottom))');
    expect(dockRules[1]).not.toContain('12px 12px max');
    // The scroller's 120px exit room is a separate, deliberate rule and stays.
    const scrollerRule = styles.match(/\.scroller\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(scrollerRule).toContain('padding-bottom: 120px');
  });

  it('soft-transitions the transient region directly above the composer', () => {
    const appSource = source('web/src/app.tsx');
    expect(appSource).toContain("from './components/collapsible.js'");
    expect(appSource).toContain('const dockOpen = Boolean(session.notice) || !connected');
    // Collapsible is the first dock child and wraps every transient block
    // (notice, connection feedback, pending approval/question) up to the composer.
    expect(appSource).toMatch(
      /<div className="action-dock">\s*<Collapsible open=\{dockOpen\}>[\s\S]*?<PendingActions[\s\S]*?<\/Collapsible>\s*<Composer/,
    );
  });

  it('soft-transitions the session details panel in the title area', () => {
    const appSource = source('web/src/app.tsx');
    expect(appSource).toMatch(/<Collapsible open=\{detailsOpen\}>\s*<SessionDetails[\s\S]*?<\/Collapsible>/);
    // The old conditionally-mounted render pops the panel in and out.
    expect(appSource).not.toContain('{detailsOpen ? <SessionDetails');
  });

  it('keeps notice spacing through the new collapsible nesting', () => {
    const feedbackCss = source('web/src/components/feedback.css');
    expect(feedbackCss).toContain('.action-dock .step-collapse > .step-collapse-content > .feedback,');
    expect(feedbackCss).toMatch(/\.action-dock > \.feedback,[\s\S]*?margin-bottom: 10px/);
  });
});
