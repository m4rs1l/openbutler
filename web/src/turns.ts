import type { Entry } from './types.js';
import { toolEntryCommand } from '../../src/tool-display.js';
export { reasoningSentences, reasoningTitle, thoughtHeadline } from './reasoning-headline.js';

export interface Turn {
  id: string;
  user: Entry | null;
  steps: Entry[];
  assistant: Entry[];
  timeline: Entry[];
  startedAt: number | null;
  endedAt: number | null;
}

function isStep(entry: Entry): boolean {
  return entry.kind === 'reasoning' || entry.kind === 'tool';
}

/**
 * A turn is one owner message and everything the agent did for it. Grouping is
 * what turns a flat log into readable work: the header answers "what did I ask",
 * the steps answer "what happened", the assistant text answers "what came back".
 */
export function buildTurns(entries: Entry[], base = 0): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  // Older held steering messages could keep a separate turn id even though the
  // agent processed them in the preceding turn. Reconcile those saved records
  // for display without rewriting the transcript.
  const lastWorkByTurn = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'user' && entry.turnId) lastWorkByTurn.set(entry.turnId, index);
  });
  const displayTurnIds = new Map<string, string>();
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (
      entry.kind === 'user' &&
      previous?.kind === 'user' &&
      previous.turnOutcome === 'completed' &&
      previous.turnId &&
      entry.turnId &&
      !entry.turnOutcome &&
      !lastWorkByTurn.has(entry.turnId) &&
      (lastWorkByTurn.get(previous.turnId) ?? -1) > index
    )
      displayTurnIds.set(entry.turnId, previous.turnId);
  });
  // The turn being built, so a message the owner sent into a run that was still
  // going stays in that turn instead of opening a new one.
  let currentTurnId: string | undefined;
  // Turn ids double as virtual-list keys, so they must stay unique even when the
  // transcript carries one turn id across several messages.
  const used = new Set<string>();
  // Turns by the id their entries carry, so an entry that names its turn lands
  // there even when the array placed it a little earlier than its message.
  const byTurn = new Map<string, Turn>();

  const open = (entry: Entry | null, index: number): Turn => {
    const wanted = entry?.turnId ?? entry?.eventId ?? `turn-${base + index}`;
    const id = used.has(wanted) ? `${wanted}-${base + index}` : wanted;
    used.add(id);
    const turn: Turn = {
      id,
      user: null,
      steps: [],
      assistant: [],
      timeline: [],
      startedAt: entry?.at ?? null,
      endedAt: null,
    };
    turns.push(turn);
    if (entry?.turnId !== undefined) byTurn.set(entry.turnId, turn);
    return turn;
  };

  for (const [index, entry] of entries.entries()) {
    const turnId = entry.turnId ? (displayTurnIds.get(entry.turnId) ?? entry.turnId) : undefined;
    // Text the machinery wrote is stored so the record stays complete, but it is
    // not part of the conversation: it must never count as an answer or as work.
    // It rides the timeline only so the compaction group can carry it between
    // its boundary rows, the way the terminal already shows it.
    if (entry.internal === 'compaction') {
      // Thinking too: the reasoning belongs to the compaction that produced it,
      // and dropping it here left the reader with no trace of either.
      const carries = (entry.kind === 'assistant' || entry.kind === 'reasoning') && Boolean(entry.text?.trim());
      if (carries) {
        if (!current) current = open(null, index);
        current.timeline.push(entry);
        if (entry.at) current.endedAt = entry.at;
      }
      continue;
    }
    if (entry.kind === 'user' && (turnId === undefined || turnId !== currentTurnId)) {
      current = open(entry, index);
      current.user = entry;
      currentTurnId = turnId;
      continue;
    }
    if (!current) {
      current = open(null, index);
      currentTurnId = undefined;
    }
    // An entry that names a turn belongs to that turn. Falling back to position
    // alone is what put a fresh thought above the message that asked for it.
    if (turnId !== undefined && turnId !== currentTurnId) {
      const named = byTurn.get(turnId);
      if (named) {
        current = named;
        currentTurnId = turnId;
      }
    }
    current.timeline.push(entry);
    if (entry.at && current.startedAt === null) current.startedAt = entry.at;
    if (entry.at) current.endedAt = entry.at;

    if (isStep(entry)) {
      current.steps.push(entry);
      continue;
    }
    if (entry.kind === 'assistant') {
      current.assistant.push(entry);
      continue;
    }
  }

  return turns;
}

/**
 * True while the owner's message has been taken and nothing has come back for
 * it yet. That window is the only honest place for a "working" dot: once the
 * first chunk lands, the answer itself is the feedback.
 */
export function awaitingFirstChunk(turns: Turn[], liveTurnId: string | undefined): boolean {
  if (liveTurnId === undefined) return false;
  const last = turns[turns.length - 1];
  return last !== undefined && last.id === liveTurnId && last.timeline.length === 0;
}

export type TurnGroup =
  | { kind: 'steps'; entries: Entry[] }
  | { kind: 'message'; entry: Entry }
  | { kind: 'compaction'; entry: Entry; summaries?: Entry[]; thoughts?: Entry[] }
  | { kind: 'divider'; entry: Entry };
/** Work and diagnostics share a group; only conversation messages close it. */
export function groupTimeline(turn: Turn): TurnGroup[] {
  const groups: TurnGroup[] = [];
  // A compaction owns what it produced: its thinking and the checkpoint it wrote
  // attach to its own row, wherever this turn carries that row. Provenance alone
  // decides: a transcript that lost the marker is stamped when its session opens.
  let compaction: Extract<TurnGroup, { kind: 'compaction' }> | null = null;
  for (const entry of turn.timeline) {
    // The renderer hides blank assistant text, so it cannot be a visible group boundary.
    if (entry.kind === 'assistant' && !entry.text?.trim()) continue;
    // The compaction checkpoint attaches under its boundary rows, never as a
    // message: a summary nobody asked for must not read as an answer. The row can
    // be anywhere in this turn - adjacency is what used to drop it on the floor.
    if (entry.internal === 'compaction') {
      if (compaction && entry.text?.trim()) {
        if (entry.kind === 'assistant') {
          compaction.summaries ??= [];
          compaction.summaries.push(entry);
        } else if (entry.kind === 'reasoning') {
          compaction.thoughts ??= [];
          compaction.thoughts.push(entry);
        }
      }
      continue;
    }
    // Compaction is its own event: it is not work the agent did, and folding it
    // into a step group would hide the moment the context changed.
    if (entry.kind === 'compaction') {
      const own: Extract<TurnGroup, { kind: 'compaction' }> = { kind: 'compaction', entry };
      groups.push(own);
      compaction = own;
      continue;
    }
    if (entry.kind === 'user' || entry.kind === 'assistant') {
      groups.push({ kind: 'message', entry });
      continue;
    }
    // A divider is a boundary the backend wrote (settings change, day break):
    // folding it into a step group would hide the moment the context changed.
    if (entry.kind === 'divider') {
      groups.push({ kind: 'divider', entry });
      continue;
    }
    const previous = groups[groups.length - 1];
    if (previous?.kind === 'steps') previous.entries.push(entry);
    else groups.push({ kind: 'steps', entries: [entry] });
  }
  return groups;
}

/**
 * The newest step group of the newest turn is the one still being written to,
 * so it is the only group that opens by itself. Starting the next group folds
 * the previous one; older turns stay folded until the reader opens them.
 */
export function activeGroupIndex(groups: readonly TurnGroup[], current: boolean): number {
  if (!current) return -1;
  // Only work that is still the newest thing in the turn stays open. Once the
  // answer starts streaming after it, that work is history: it folds so the
  // reader reads the text, not the log of how it was produced.
  const last = groups[groups.length - 1];
  return last?.kind === 'steps' ? groups.length - 1 : -1;
}

/** A boundary the reader must keep seeing: a divider or a compaction row. */
function isTrailing(group: TurnGroup): group is Extract<TurnGroup, { kind: 'divider' | 'compaction' }> {
  return group.kind === 'divider' || group.kind === 'compaction';
}

/**
 * Whether the run behind this turn ended interrupted rather than completed.
 *
 * The stamp lives on the turn's ask, so turns recorded before it existed report
 * `false` - a stopped or failed turn from an old transcript reads like one that
 * finished. The disclosure treats both as "fold the log" for those, which is
 * the pre-existing behaviour, not a regression we are introducing.
 */
export function turnInterrupted(turn: Turn): boolean {
  return turn.user?.turnOutcome === 'cancelled' || turn.user?.turnOutcome === 'failed';
}

/**
 * Whether the work disclosure opens by itself. A reader's explicit choice always
 * wins; failing that, the disclosure stays open while the turn is live, when the
 * turn carries no ask at all, when the owner spoke inside it, and when the turn
 * ended interrupted - the failure detail lives inside the disclosure, and folding
 * it would hide the one thing the reader came back to look at.
 */
export function workDetailsOpen(expanded: boolean | null, live: boolean, turn: Turn, detailsContainUserMessage: boolean): boolean {
  if (expanded !== null) return expanded;
  return live || turn.user === null || turnInterrupted(turn) || detailsContainUserMessage;
}

/** Keep the latest answer outside the work disclosure; interrupted text stays in the log. */
export function turnContents(
  turn: Turn,
  timeline?: TurnGroup[],
): {
  details: TurnGroup[];
  answer: Entry | null;
  afterword: Extract<TurnGroup, { kind: 'divider' | 'compaction' }>[];
} {
  const groups = timeline ?? groupTimeline(turn);
  let answerIndex = groups.length - 1;
  // Connection/status notices appended after an answer do not turn it back into work.
  // Neither do dividers or a compaction boundary: they record when the transcript
  // changed, not more work. A compaction behind the answer used to demote it into
  // the disclosure, which is why a finished turn lost its reply after compacting.
  while (answerIndex >= 0) {
    const group = groups[answerIndex];
    if (isTrailing(group)) {
      answerIndex--;
      continue;
    }
    if (
      group.kind !== 'steps' ||
      !group.entries.every((entry) => (entry.kind === 'notice' || entry.kind === 'system') && entry.tone !== 'error')
    )
      break;
    answerIndex--;
  }
  const last = groups[answerIndex];
  const interrupted = turnInterrupted(turn);
  const answer = !interrupted && last?.kind === 'message' && last.entry.kind === 'assistant' && last.entry.text?.trim() ? last.entry : null;
  // A trailing boundary renders at section level: folding it with the work would
  // hide the boundary the reader came back for. A compaction row belongs there as
  // much as a divider does - without it the rows disappear with the disclosure the
  // moment the turn finishes.
  const afterword: Extract<TurnGroup, { kind: 'divider' | 'compaction' }>[] = answer
    ? groups.slice(answerIndex + 1).filter(isTrailing)
    : [];
  const details = answer
    ? groups.filter((group, index) => index !== answerIndex && !(index > answerIndex && isTrailing(group)))
    : [...groups];
  if (!answer) {
    while (details.length > 0 && isTrailing(details[details.length - 1]!)) {
      afterword.unshift(details.pop() as Extract<TurnGroup, { kind: 'divider' | 'compaction' }>);
    }
  }
  return { details, answer, afterword };
}

/** A thinking block names its own duration, the way the terminal header does. */
export function thoughtLabel(durationMs: number | undefined): string {
  return durationMs === undefined ? 'Thought' : `Thought for ${formatDuration(durationMs)}`;
}

/** Total thinking time in a group; unknown as soon as one block is unstamped. */
export function thoughtDuration(entries: readonly Entry[]): number | undefined {
  let total = 0;
  let blocks = 0;
  for (const entry of entries) {
    if (entry.kind !== 'reasoning') continue;
    if (entry.durationMs === undefined) return undefined;
    total += entry.durationMs;
    blocks += 1;
  }
  return blocks === 0 ? undefined : total;
}

/** What a step actually did, so a group can say "3 komut" instead of "Komutlar". */
export type ToolCategory =
  | 'command'
  | 'browser'
  | 'read'
  | 'write'
  | 'search'
  | 'image'
  | 'skill'
  | 'memory'
  | 'team'
  | 'agent'
  | 'session'
  | 'message'
  | 'schedule'
  | 'tool';

const CATEGORY_WORDS: Record<ToolCategory, { one: string; many: string; done: string; running: string }> = {
  command: { one: 'command', many: 'commands', done: 'run', running: 'running' },
  browser: { one: 'browser call', many: 'browser calls', done: 'made', running: 'in progress' },
  read: { one: 'file', many: 'files', done: 'read', running: 'being read' },
  write: { one: 'file', many: 'files', done: 'written', running: 'being written' },
  search: { one: 'search', many: 'searches', done: 'done', running: 'running' },
  image: { one: 'image', many: 'images', done: 'loaded', running: 'loading' },
  skill: { one: 'skill', many: 'skills', done: 'read', running: 'being read' },
  memory: { one: 'memory operation', many: 'memory operations', done: 'done', running: 'running' },
  team: { one: 'team message', many: 'team messages', done: 'sent', running: 'sending' },
  agent: { one: 'subagent task', many: 'subagent tasks', done: 'run', running: 'running' },
  session: { one: 'session read', many: 'session reads', done: 'done', running: 'running' },
  message: { one: 'message', many: 'messages', done: 'sent', running: 'sending' },
  schedule: { one: 'schedule', many: 'schedules', done: 'updated', running: 'updating' },
  tool: { one: 'tool', many: 'tools', done: 'run', running: 'running' },
};

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif)\b/i;

/** A tool call's identity is `provider:name`; the display command carries the path. */
export function classifyTool(entry: Entry): ToolCategory {
  const [provider = '', name = ''] = (entry.tool ?? '').toLowerCase().split(':');
  const command = toolEntryCommand(entry);
  if (provider === 'host') {
    if (name === 'execute_command') return 'command';
    if (name === 'file_read') {
      if (/SKILL\.md/i.test(command)) return 'skill';
      if (IMAGE_FILE.test(command)) return 'image';
      return 'read';
    }
    if (name === 'file_write' || name === 'file_edit') return 'write';
    if (name === 'glob' || name === 'grep') return 'search';
    if (name.startsWith('memory_')) return 'memory';
    if (name.startsWith('team_')) return 'team';
    if (name === 'subagent' || name === 'subagent_stop' || name === 'parent_message') return 'agent';
    if (name.startsWith('session_')) return 'session';
    if (name === 'inbox' || name === 'send_message_to_owner' || name === 'session_message') return 'message';
    if (name === 'schedule') return 'schedule';
    return 'tool';
  }
  if (/playwright|chrome|browser|cua/.test(provider)) return 'browser';
  return 'tool';
}

function countByCategory(entries: readonly Entry[], verb: 'done' | 'running'): string[] {
  const counts = new Map<ToolCategory, number>();
  for (const entry of entries) {
    const category = classifyTool(entry);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => {
      const words = CATEGORY_WORDS[category];
      return `${count} ${count === 1 ? words.one : words.many} ${words[verb]}`;
    });
}

/**
 * What the group did, counted: "2 commands running, 4 commands run".
 * Work in flight comes first, because that is the part still changing.
 */
export function groupSummary(entries: readonly Entry[], maxParts = 3): string {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  if (!tools.length) {
    if (entries.some((entry) => entry.kind === 'reasoning')) return thoughtLabel(thoughtDuration(entries));
    return 'Notifications';
  }
  const running = tools.filter((entry) => entry.running === true || entry.preparing === true);
  const done = tools.filter((entry) => entry.running !== true && entry.preparing !== true);
  const parts = [...countByCategory(running, 'running'), ...countByCategory(done, 'done')];
  return parts.slice(0, maxParts).join(', ') + (parts.length > maxParts ? '…' : '');
}

/**
 * What an open group's header should say, in priority order: the command that is
 * running now, the thought being written, then the command that ran last.
 * This signal belongs to the active group, including while collapsed;
 * completed groups use their work summary instead.
 */
export type GroupSignal = { kind: 'headline' | 'command' | 'summary'; text: string };

export function groupSignal(entries: readonly Entry[], headline: string): GroupSignal {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const running = [...tools].reverse().find((entry) => entry.running === true || entry.preparing === true);
  if (running) return { kind: 'command', text: toolEntryCommand(running) };
  if (headline) return { kind: 'headline', text: headline };
  const last = tools[tools.length - 1];
  if (last) return { kind: 'command', text: toolEntryCommand(last) };
  return { kind: 'summary', text: groupSummary(entries) };
}

export function turnDuration(turn: Turn): number | null {
  const end = turn.user?.turnEndedAt ?? turn.endedAt;
  if (turn.startedAt === null || end === null) return null;
  return Math.max(0, end - turn.startedAt);
}

/**
 * Human scale for a turn header or a thought label: whole seconds under a
 * minute, then minutes, hours and days, dropping exact zero parts -
 * `7m 34s`, `48m`, `1h 34m`, `1d 14h`. Only the sub-second window keeps
 * a decimal, so a fresh block does not read as `0s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export function isShellTool(entry: Entry): boolean {
  const tool = entry.tool || entry.command?.split(/\s/, 1)[0] || '';
  return /(?:^|[/:])(?:execute_command|exec_command|shell|bash|powershell|pwsh|cmd|cd|Get-[a-z]+|Select-[a-z]+|node|npm|npx|git|rg)$/i.test(
    tool,
  );
}

/** Short, stable label for a tool call: the verb plus its target. */
export function stepLabel(entry: Entry): { verb: string; target: string } {
  if (entry.kind === 'reasoning') return { verb: 'Thought', target: '' };
  const command = toolEntryCommand(entry);
  const space = command.indexOf(' ');
  if (space === -1) return { verb: command, target: '' };
  return { verb: command.slice(0, space), target: command.slice(space + 1) };
}
