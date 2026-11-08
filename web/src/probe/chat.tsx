// Synthetic transcript for the resize probe (`npm run probe:resize`).
//
// Renders the real VirtualList and TurnView with deterministic content so the
// resize-probe script can measure how the transcript behaves while a window
// narrows. The transcript is long on purpose: geometry that drifts per
// measurement only becomes visible once many rows remain unmeasured.
import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { Entry } from '../types.js';
import { buildTurns } from '../turns.js';
import { TurnView } from '../turn.js';
import { VirtualList } from '../virtual.js';
import '../styles.css';

const WORDS =
  'the workspace transcript keeps a measured geometry per row and only mounts the visible slice while the reader follows the tail of a long conversation with tool output and reasoning steps interleaved';

function sentence(seed: number, count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (seed * 7 + index * 13) % WORDS.length;
    parts.push(`${WORDS.slice(offset, offset + 60)}.`);
  }
  return parts.join(' ');
}

function makeEntries(turnCount: number): Entry[] {
  const entries: Entry[] = [];
  for (let index = 0; index < turnCount; index += 1) {
    const turnId = `t${index}`;
    entries.push({ kind: 'user', text: `Request ${index}: ${sentence(index, 1)}`, turnId, at: index * 60_000 });
    entries.push({
      kind: 'reasoning',
      text: sentence(index + 101, 2),
      turnId,
      at: index * 60_000 + 1_000,
      durationMs: 1_000 + (index % 5) * 500,
    });
    if (index % 3 === 1) {
      entries.push({
        kind: 'tool',
        tool: 'shell',
        command: `ls -la folder-${index}`,
        text: `file listing output for folder-${index}\n${sentence(index + 55, 3)}`,
        turnId,
        at: index * 60_000 + 2_000,
      });
    }
    entries.push({
      kind: 'assistant',
      text: `Result ${index}: ${sentence(index + 201, 2 + (index % 3))}`,
      turnId,
      at: index * 60_000 + 3_000,
    });
  }
  return entries;
}

function ProbeChat({ turnCount }: { turnCount: number }) {
  const turns = useMemo(() => buildTurns(makeEntries(turnCount)), [turnCount]);
  return (
    <div className="app">
      <div className="workspace-surface">
        <header className="topbar">
          <span className="session-title">resize probe</span>
        </header>
        <main className="conversation">
          <VirtualList
            items={turns}
            getKey={(turn) => turn.id}
            estimate={180}
            hasOlder={false}
            followRequest={0}
            render={(turn) => <TurnView turn={turn} live={false} sessionId="probe" />}
          />
          <div className="action-dock">
            <div className="composer" style={{ minHeight: 64 }} />
          </div>
        </main>
      </div>
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container.');
createRoot(container).render(<ProbeChat turnCount={Number(params.get('n') || 300)} />);
requestAnimationFrame(() => requestAnimationFrame(() => ((window as { __probeReady?: boolean }).__probeReady = true)));
