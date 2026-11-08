import { randomUUID } from 'node:crypto';
import type { AgentEnvironment, AgentSessionController } from '../agent-session.js';
import type { ActivityLedger, ObservedEventInput, ObservedEventRow } from '../activity-ledger.js';
import { canonicalScopeRoot as canonicalWorkspaceRoot } from '../workspace-origin.js';
import {
  assembleWakeText,
  describeSchedule,
  generateScheduleId,
  normalizeScheduleTrigger,
  readScheduleRuntime,
  readTriggerDue,
  scheduleCapabilities,
  type ScheduleRunner,
  validateScheduleTrigger,
  writeScheduleError,
  writeScheduleRunFinished,
  writeScheduleRunStarted,
} from '../tools/schedule.js';
import { loadSettings, parseScheduleState, saveSettings, type ScheduleState } from '../settings.js';

export interface ScheduleServiceDeps<W extends { runtime: AgentEnvironment }> {
  ledger: ActivityLedger;
  scheduler: ScheduleRunner;
  stopGenerations: Map<string, number>;
  isClosing: () => boolean;
  getWorkspace: (path: string) => PromiseLike<W>;
  getPersistentSession: (
    workspace: W,
    key: string,
    isBackground: boolean,
  ) => PromiseLike<{ session: { controller: AgentSessionController } }>;
  ensureOwnerInboxWakes: () => void;
  pumpEvents: () => void;
  receiveEvent: (event: ObservedEventInput) => PromiseLike<void>;
  stopNamedRun: (key: string, options?: { keepQueue?: boolean; holdQueue?: boolean }) => void;
  findSessionController: (sessionId: string) => AgentSessionController | undefined;
  requireString: (value: unknown, name: string, maxBytes: number) => string;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getEventRetryTimer: () => ReturnType<typeof setTimeout> | null;
  setEventRetryTimer: (value: ReturnType<typeof setTimeout> | null) => void;
  getEventRetryDue: () => number;
  setEventRetryDue: (value: number) => void;
}

export interface ScheduleService {
  processScheduleEvent(event: ObservedEventRow, key: string, schedule: ScheduleState, stopGeneration: number): Promise<void>;
  scheduleEventRetry(at: number): void;
  executeBackground(input: Record<string, unknown>, workspaceRoot?: string, senderSessionId?: string): Promise<unknown>;
}

export function createScheduleService<W extends { runtime: AgentEnvironment }>(deps: ScheduleServiceDeps<W>): ScheduleService {
  const {
    ledger,
    scheduler,
    stopGenerations,
    isClosing,
    getWorkspace,
    getPersistentSession,
    ensureOwnerInboxWakes,
    pumpEvents,
    receiveEvent,
    stopNamedRun,
    findSessionController,
    requireString,
    isRecord,
    getEventRetryTimer,
    setEventRetryTimer,
    getEventRetryDue,
    setEventRetryDue,
  } = deps;

  /** Latest assistant text in a session, or null when the run said nothing. */
  function lastAssistantText(controller: AgentSessionController): string | null {
    const entries = controller.getSnapshot().session.entries;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.kind === 'assistant' && entry.text.trim()) return entry.text;
    }
    return null;
  }

  /**
   * One schedule firing, start to finish. The run attaches to the origin session
   * when it is still alive (the report appears where the schedule was asked
   * for); otherwise it continues in the schedule-owned background session with a
   * provenance note. Every outcome lands in durable runtime state: counters
   * bump on completed and failed runs alike, and the closing message becomes
   * the schedule's report.
   */
  async function processScheduleEvent(
    event: ObservedEventRow,
    key: string,
    schedule: ScheduleState,
    stopGeneration: number,
  ): Promise<void> {
    let configuredRoot: string;
    try {
      configuredRoot = canonicalWorkspaceRoot(schedule.workspaceRoot);
    } catch {
      // The workspace is gone: fail visibly, mark the schedule, never retry-loop.
      writeScheduleError(ledger, schedule.id, `Workspace is missing: ${schedule.workspaceRoot}`);
      ledger.setEventState(event.id, 'failed', `Workspace is missing: ${schedule.workspaceRoot}`);
      return;
    }
    const workspace = await getWorkspace(configuredRoot);
    const facts = event.payload.facts;
    const factsRecord = facts !== null && typeof facts === 'object' ? (facts as Record<string, unknown>) : {};
    const scheduledAt =
      typeof factsRecord.scheduledAt === 'string' && Number.isFinite(Date.parse(factsRecord.scheduledAt))
        ? Date.parse(factsRecord.scheduledAt)
        : undefined;
    const runtime = readScheduleRuntime(ledger, schedule.id);
    const scheduleInfo = describeSchedule(schedule, Date.now(), readTriggerDue(ledger, schedule));
    const text = assembleWakeText({
      schedule,
      scheduleHuman: scheduleInfo.human,
      runNumber: runtime.runCount + 1,
      ...(runtime.lastResult === undefined ? {} : { lastResult: runtime.lastResult, lastRunAtMs: runtime.lastRunAt }),
      ...(scheduledAt === undefined ? {} : { scheduledAtMs: scheduledAt }),
      nowMs: Date.now(),
      ...(factsRecord.clockShift === true ? { clockShift: true as const } : {}),
      facts: facts ?? {},
    });
    const origin = findSessionController(schedule.originSessionId);
    let controller: AgentSessionController;
    let opening = text;
    if (origin) {
      controller = origin;
    } else {
      if (schedule.originSessionId) {
        opening =
          `Created in session ${schedule.originSessionId}, which no longer exists. Continuing in the schedule session; ` +
          `earlier runs remain readable with session tools.\n\n${text}`;
      }
      controller = (await getPersistentSession(workspace, key, true)).session.controller;
    }
    if (isClosing()) throw new Error('Host is shutting down.');
    if ((stopGenerations.get(key) ?? 0) !== stopGeneration) throw new Error('Run cancelled before execution.');
    writeScheduleRunStarted(ledger, schedule.id, Date.now());
    await controller.sendMessage({
      text: opening,
      images: [],
      eventId: event.id,
      communication: { source: 'schedule' },
      reviewAuthorization: {
        kind: 'schedule',
        name: schedule.name,
        instruction: schedule.instruction,
        triggerFacts: event.payload.facts,
      },
    });
    await controller.flushSave();
    const turnResult = controller.takeEventRunResult(event.id);
    const error = turnResult ? turnResult.error : controller.getLastRunError();
    const report = error ? undefined : (lastAssistantText(controller) ?? undefined);
    writeScheduleRunFinished(
      ledger,
      schedule.id,
      error ? { result: 'failed', error } : { result: 'completed', ...(report ? { report } : {}) },
    );
    ledger.setEventState(event.id, error ? 'failed' : 'delivered', error ?? undefined);
    if (turnResult?.replyHandledByEventId) {
      ledger.setState(`event:reply-owner:${event.id}`, turnResult.replyHandledByEventId);
    }
  }

  function scheduleEventRetry(at: number): void {
    const timer = getEventRetryTimer();
    if (isClosing() || (timer !== null && getEventRetryDue() <= at)) return;
    if (timer !== null) clearTimeout(timer);
    setEventRetryDue(at);
    const nextTimer = setTimeout(
      () => {
        setEventRetryTimer(null);
        if (!isClosing()) {
          ensureOwnerInboxWakes();
          pumpEvents();
        }
      },
      Math.max(0, at - Date.now()),
    );
    setEventRetryTimer(nextTimer);
    nextTimer.unref?.();
  }

  async function executeBackground(input: Record<string, unknown>, workspaceRoot?: string, senderSessionId?: string): Promise<unknown> {
    const action = String(input.action ?? '');
    if (action === 'capabilities') return { adapters: scheduleCapabilities };
    const settings = loadSettings();
    if (action === 'list') {
      const adapterStates = new Map(scheduler.listStatuses().map((status) => [status.id, status]));
      return {
        schedules: settings.schedules.map((schedule) => ({
          ...schedule,
          adapterState: adapterStates.get(schedule.id)?.state ?? 'idle',
          ...(adapterStates.get(schedule.id)?.error ? { adapterError: adapterStates.get(schedule.id)?.error } : {}),
          runtime: readScheduleRuntime(ledger, schedule.id),
          schedule: describeSchedule(schedule, Date.now(), readTriggerDue(ledger, schedule)),
        })),
      };
    }
    if (action === 'log') {
      const scheduleId = requireString(input.scheduleId, 'scheduleId', 64);
      const schedule = settings.schedules.find((candidate) => candidate.id === scheduleId);
      if (!schedule) throw new Error('Schedule does not exist.');
      return {
        scheduleId,
        runs: ledger.scheduleEvents(scheduleId, 50).map((event) => ({
          eventId: event.id,
          kind: event.kind,
          status: event.status,
          occurredAt: event.occurredAt,
          receivedAt: event.receivedAt,
          scheduledAt:
            event.payload.facts !== null && typeof event.payload.facts === 'object' && 'scheduledAt' in event.payload.facts
              ? (event.payload.facts as Record<string, unknown>).scheduledAt
              : undefined,
          ...(event.error ? { error: event.error } : {}),
        })),
      };
    }
    if (action === 'add' || action === 'update') {
      if (!isRecord(input.schedule)) throw new Error('schedule must be an object.');
      if (input.schedule.workspaceRoot === undefined && !workspaceRoot)
        throw new Error('Choose a workspace with --workspace or set workspaceRoot in the schedule.');
      const rawSchedule: Record<string, unknown> = {
        ...input.schedule,
        ...(input.schedule.workspaceRoot === undefined ? { workspaceRoot } : {}),
      };
      if (action === 'add' && (typeof rawSchedule.id !== 'string' || !rawSchedule.id)) {
        const name = typeof rawSchedule.name === 'string' ? rawSchedule.name : '';
        rawSchedule.id = generateScheduleId(name, new Set(settings.schedules.map((candidate) => candidate.id)));
      }
      if (rawSchedule.originSessionId === undefined) {
        const existing = action === 'update' ? settings.schedules.find((candidate) => candidate.id === rawSchedule.id) : undefined;
        rawSchedule.originSessionId = existing?.originSessionId ?? senderSessionId ?? '';
      }
      const schedule = parseScheduleState(rawSchedule);
      schedule.trigger = normalizeScheduleTrigger(schedule.trigger);
      validateScheduleTrigger(schedule.trigger);
      canonicalWorkspaceRoot(schedule.workspaceRoot);
      const index = settings.schedules.findIndex((candidate) => candidate.id === schedule.id);
      if (action === 'add' && index >= 0) throw new Error('A schedule with that id already exists.');
      if (action === 'update' && index < 0) throw new Error('Schedule does not exist.');
      if (index < 0) settings.schedules.push(schedule);
      else settings.schedules[index] = schedule;
      saveSettings(settings);
      await scheduler.reload(settings.schedules);
      const runtime = scheduler.listStatuses().find((candidate) => candidate.id === schedule.id);
      return { status: runtime?.state === 'error' ? 'error' : 'completed', schedule: schedule, runtime, saved: true };
    }
    const scheduleId = requireString(input.scheduleId, 'scheduleId', 64);
    const schedule = settings.schedules.find((candidate) => candidate.id === scheduleId);
    if (!schedule) throw new Error('Schedule does not exist.');
    if (action === 'run') {
      if (!schedule.enabled) throw new Error('Enable the schedule before running it.');
      await receiveEvent({
        source: 'schedule:manual',
        kind: 'schedule.requested',
        dedupeKey: `schedule:${schedule.id}:manual:${randomUUID()}`,
        workspaceRoot: schedule.workspaceRoot,
        payload: { scheduleId: schedule.id, facts: { requestedAt: new Date().toISOString() } },
      });
      return { status: 'queued', scheduleId };
    }
    if (!['remove', 'enable', 'disable'].includes(action)) throw new Error(`Unknown schedule action: ${action}`);
    if (action === 'remove') settings.schedules = settings.schedules.filter((candidate) => candidate.id !== scheduleId);
    else schedule.enabled = action === 'enable';
    if (action === 'remove' || action === 'disable') stopNamedRun(`schedule:${scheduleId}`);
    saveSettings(settings);
    await scheduler.reload(settings.schedules);
    const runtime = scheduler.listStatuses().find((candidate) => candidate.id === scheduleId);
    return { status: runtime?.state === 'error' ? 'error' : 'completed', scheduleId, runtime, saved: true };
  }

  return { processScheduleEvent, scheduleEventRetry, executeBackground };
}
