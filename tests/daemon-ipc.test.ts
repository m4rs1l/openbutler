import { toolEntryCommand } from '../src/tool-display.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { pathToFileURL } from 'node:url';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionClient } from '../src/agent-session.js';
import type { DaemonHost } from '../src/daemon-host.js';
import { ToolRegistry, type ToolDefinition } from '../src/tools/registry.js';

const daemonStart = vi.hoisted(() => ({ run: vi.fn(), runtimeOptions: vi.fn() }));
vi.mock('../src/daemon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon.js')>();
  return { ...actual, startDaemon: daemonStart.run };
});

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
let root: string;
let host: DaemonHost;
let server: Server;
/** Every model a runtime was switched to, in order: the head's pin must show up here. */
let fixtureSelectModels: Array<{ providerId: string; modelId: string }> = [];
let clients: AgentSessionClient[];
let connect: (typeof import('../src/daemon-client.js'))['connectDaemonSession'];
let requestHost: (typeof import('../src/daemon.js'))['requestHost'];
let model: MockLanguageModelV3;
let registry: FixtureRegistry;
let fixtureVision = false;
/** The head's own-turn gap; a test that needs one sets this before replacing the host. */
let fixtureSettingsReload: AgentEnvironment['reloadSettings'];
const subagentSeen = new WeakSet<ToolRegistry>();
const subagentStopSeen = new WeakSet<ToolRegistry>();
const inboxSeen = new WeakSet<ToolRegistry>();

/**
 * The registry a test registers its own tools on. Production builds one registry per runtime
 * (agent-runtime.ts), so a host tool that captures its runtime's workspace scope always carries
 * the scope of the runtime that owns it. A fixture sharing one registry across runtimes would let
 * whichever runtime came first - the custodian, installed at host start - decide that scope for
 * every other runtime. Keeping the definitions here lets each runtime be handed a registry of its
 * own, exactly as production does.
 */
class FixtureRegistry extends ToolRegistry {
  readonly recorded: ToolDefinition[] = [];

  override register(definition: ToolDefinition): void {
    super.register(definition);
    this.recorded.push(definition);
  }
}

function stream(parts: LanguageModelV3StreamPart[], reason: 'stop' | 'tool-calls' = 'stop') {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.enqueue({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
        controller.close();
      },
    }),
  };
}
function textStream(text: string) {
  return stream([
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: text },
    { type: 'text-end', id: 'answer' },
  ]);
}
/** A worker stream that keeps its run alive until the run is stopped. */
function holdOpenWorkerStream(signal?: AbortSignal | null) {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'work' });
        controller.enqueue({ type: 'text-delta', id: 'work', delta: 'Working…' });
        const finish = () => {
          try {
            controller.enqueue({ type: 'text-end', id: 'work' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            controller.close();
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      },
    }),
  };
}

type BackgroundManage = Parameters<(typeof import('../src/tools/schedule.js'))['createScheduleTool']>[1];

let fixtureBackgroundManage: BackgroundManage | undefined;
/** The owner-message tool as the custodian runtime registered it, or undefined when no runtime got one. */
let fixtureOwnerTool: ToolDefinition | undefined;
/** The custodian's approval verb, captured the same way. */
let fixtureApprovalDecide: ToolDefinition | undefined;
let fixtureSessionMessageTool: ToolDefinition | undefined;

/**
 * The registry one runtime is given. Production builds one per runtime (agent-runtime.ts), so a
 * host tool that captures its runtime's workspace scope always carries the scope of the runtime
 * that owns it. A fixture sharing one registry across runtimes would let the custodian - built
 * first, at host start - decide the approval scope of every chat's schedule tool.
 */
async function registryAt(workspaceRoot: string): Promise<ToolRegistry> {
  const scoped = new ToolRegistry();
  for (const definition of registry.recorded) scoped.register(definition);
  if (fixtureBackgroundManage) {
    const { createScheduleTool } = await import('../src/tools/schedule.js');
    scoped.register(createScheduleTool(workspaceRoot, fixtureBackgroundManage));
  }
  return scoped;
}

async function createFixtureHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  return createDaemonHost({
    startedAt: new Date().toISOString(),
    requestStop: () => {},
    log: () => {},
    // The gap exists so a chatty sender cannot spend the head's attention; tests
    // exercise ordering, not wall-clock waiting, except where they set their own.
    runtimeFactory: async (options) => {
      daemonStart.runtimeOptions(options);
      fixtureBackgroundManage = options?.backgroundManage;
      if (options?.inbox && !inboxSeen.has(registry)) {
        const { createInboxTool } = await import('../src/tools/inbox.js');
        registry.register(createInboxTool(options.inbox));
        inboxSeen.add(registry);
      }
      const subagent = options?.subagent;
      const subagentStop = options?.subagentStop;
      const workspaceRoot = options?.workspaceRoot ?? process.cwd();
      if (subagent && !subagentSeen.has(registry)) {
        const { createSubagentTool } = await import('../src/tools/subagent.js');
        registry.register(createSubagentTool(subagent));
        subagentSeen.add(registry);
      }
      if (subagentStop && !subagentStopSeen.has(registry)) {
        const { createSubagentStopTool } = await import('../src/tools/subagent-stop.js');
        registry.register(createSubagentStopTool(subagentStop));
        subagentStopSeen.add(registry);
      }
      const scoped = await registryAt(workspaceRoot);
      // Production registers the owner tool inside the runtime that was handed the
      // handler (agent-runtime.ts), not in the shared catalogue. Registering it on
      // the shared registry here would hand the tool to every chat and hide exactly
      // the absence the custodian plan is about.
      if (options?.ownerMessageSend) {
        const { createSendMessageToOwnerTool } = await import('../src/tools/owner-communication.js');
        fixtureOwnerTool = createSendMessageToOwnerTool(workspaceRoot, options.ownerMessageSend);
        scoped.register(fixtureOwnerTool);
      }
      // Same rule for the messaging family: a runtime holds exactly the tools it
      // was handed a handler for, so a chat never sees the head's tool.
      if (options?.sessionMessage) {
        const { createSessionMessageTool } = await import('../src/tools/session-message.js');
        fixtureSessionMessageTool = createSessionMessageTool(options.sessionMessage);
        scoped.register(fixtureSessionMessageTool);
      }
      if (options?.custodianMessage) {
        const { createCustodianMessageTool } = await import('../src/tools/custodian-message.js');
        scoped.register(createCustodianMessageTool(options.custodianMessage));
      }
      if (options?.workerMessage) {
        const { createWorkerMessageTool } = await import('../src/tools/worker-message.js');
        scoped.register(createWorkerMessageTool(options.workerMessage));
      }
      if (options?.approvalDecide) {
        const { createApprovalDecideTool } = await import('../src/tools/approval-decide.js');
        fixtureApprovalDecide = createApprovalDecideTool(options.approvalDecide);
        scoped.register(fixtureApprovalDecide);
      }
      if (options?.parentMessage) {
        const { createParentMessageTool } = await import('../src/tools/parent-message.js');
        scoped.register(createParentMessageTool(options.parentMessage));
      }
      if (options?.sessionNew) {
        const { createSessionNewTool } = await import('../src/tools/session-new.js');
        scoped.register(createSessionNewTool(options.sessionNew));
      }
      const runtime: AgentEnvironment = {
        model,
        workspaceRoot,
        modelName: 'Local fixture',
        providerId: 'fixture',
        modelId: 'fixture',
        contextWindowTokens: null,
        outputLimitTokens: null,
        supportsVision: fixtureVision,
        supportsImageToolResult: true,
        reasoningVariants: [],
        reasoningMetadataSource: null,
        reasoningSupport: 'model-unsupported',
        reasoningDefault: 'default',
        reasoningPreference: 'default',
        showReasoningDefault: false,
        saveReasoningPreference: () => {},
        saveShowReasoningPreference: () => {},
        getReasoningProviderOptions: () => ({}),
        getReviewProviderOptions: () => ({}),
        registry: scoped,
        selectModel: async (providerId: string, modelId: string) => {
          fixtureSelectModels.push({ providerId, modelId });
        },
        ...(fixtureSettingsReload ? { reloadSettings: fixtureSettingsReload } : {}),
        close: async () => {},
      };
      // Fidelity with the production runtime (agent-runtime.ts): a session whose
      // message arrives with a channel scope rebinds to it instead of failing.
      // A fixture without this diverges from prod exactly where scope rules meet.
      runtime.selectWorkspaceRoot = async (path: string) => {
        if (path !== runtime.workspaceRoot) runtime.workspaceRoot = path;
      };
      return runtime;
    },
  });
}

beforeEach(async () => {
  fixtureSelectModels = [];
  fixtureSettingsReload = undefined;
  fixtureVision = false;
  root = mkdtempSync(join(tmpdir(), 'openbutler-ipc-check-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  clients = [];
  daemonStart.run.mockReset();
  daemonStart.runtimeOptions.mockReset();
  registry = new FixtureRegistry();
  model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{"title":"Fixture session"}' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => textStream('Fixture response'),
  });
  const daemon = await import('../src/daemon.js');
  requestHost = daemon.requestHost;
  connect = (await import('../src/daemon-client.js')).connectDaemonSession;
  host = await createFixtureHost();
  server = createServer((socket) => host.handleConnection(socket));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(daemon.getDaemonEndpoint(), () => resolveListen());
  });
  await host.start();
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await host.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-ipc-check-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});
type AttachOptions = Parameters<(typeof import('../src/daemon-client.js'))['connectDaemonSession']>[1];

async function client(options: AttachOptions) {
  const result = await connect(root, options);
  clients.push(result);
  return result;
}

/** A surface opening a chat of its own, as it does when there is nothing to resume. */
function newChat(options: Omit<AttachOptions, 'chatSessionId' | 'newChatSession'> = {}) {
  return client({ ...options, newChatSession: true });
}

/** A surface reopening a chat by id, as it does for the chat the owner left off in. */
function openChat(chatSessionId: string, options: Omit<AttachOptions, 'chatSessionId' | 'newChatSession'> = {}) {
  return client({ ...options, chatSessionId });
}

function registerFakeTool(name: string): void {
  registry.register({
    providerId: 'fixture',
    name,
    description: `Fixture tool ${name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: { change: 'none', data: 'public', network: 'none', reversible: 'full', outbound: 'none' },
    execute: async () => ({ status: 'ok' }),
  });
}

function offeredToolNames(options: { tools?: unknown }): string[] {
  return (Array.isArray(options.tools) ? options.tools : []).map((tool) => {
    const name = (tool as { name?: string }).name ?? '';
    return name.startsWith('fixture__') ? name.slice('fixture__'.length) : name;
  });
}

/**
 * The id a session would get from `inbox list`. Listing does not consume, so a
 * model mock can ask for the id it is about to open - which is the flow the tool
 * now requires: list first, then open one notification by its code.
 */
/** The worker id a prompt reports, used by polling fixtures. */
function workerIdFrom(serialized: string): string {
  const match = /\\?"session\\?":\s*\\?"([0-9a-f-]{36})\\?"/.exec(serialized);
  return match ? match[1]! : 'missing';
}
async function firstInboxId(sessionId: string, source?: string): Promise<string> {
  const built = await registry.createModelTools({ sessionId, approve: async () => true, onResult: () => {} });
  const listed = (await built.tools.inbox!.execute!(
    { action: 'list', ...(source ? { source } : {}) },
    { toolCallId: 'list', messages: [] },
  )) as { items?: Array<{ id: string }> };
  const id = listed.items?.[0]?.id;
  if (!id) throw new Error('No pending notification to open.');
  return id;
}

async function replaceFixtureHost() {
  await host.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  host = await createFixtureHost();
  server = createServer((socket) => host.handleConnection(socket));
  const daemon = await import('../src/daemon.js');
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(daemon.getDaemonEndpoint(), () => resolveListen());
  });
  await host.start();
}

describe('shared host and session IPC', () => {
  it('demands an explicit target and keeps the custodian out of the chat layer', async () => {
    const { listSavedSessions, loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');

    // The custodian belongs to the host: it is written on the first start at its
    // reserved id, and every chat listing leaves it out.
    expect(loadSavedSession(CUSTODIAN_SESSION_ID)?.id).toBe(CUSTODIAN_SESSION_ID);
    expect(listSavedSessions(root).map((entry) => entry.id)).not.toContain(CUSTODIAN_SESSION_ID);

    // An attachment that names nothing has nowhere to land.
    await expect(connect(root, {})).rejects.toThrow('Choose a chat or a session to attach.');

    const chat = await client({ isolatedSession: true });
    const chatSessionId = chat.getSnapshot().session.id;
    expect(chatSessionId).not.toBe(CUSTODIAN_SESSION_ID);

    // The custodian is not a chat: neither the chat layer nor a session load reaches it.
    await expect(openChat(CUSTODIAN_SESSION_ID)).rejects.toThrow('not a chat');
    await expect(chat.loadSession(CUSTODIAN_SESSION_ID)).rejects.toThrow('not a chat');
    expect(chat.getSnapshot().session.id).toBe(chatSessionId);

    // A socket is bound to the workspace it attached to, whatever it asks for later.
    const bound = chat as AgentSessionClient & { workspaceKey: string };
    const originalKey = bound.workspaceKey;
    try {
      bound.workspaceKey = join(root, 'another-workspace');
      await expect(chat.listSessions()).rejects.toThrow('This IPC client is not attached to that workspace.');
    } finally {
      bound.workspaceKey = originalKey;
    }
    expect(Array.isArray(await chat.listSessions())).toBe(true);
  });

  it('runs independent web chats concurrently and stops only the addressed chat', async () => {
    const { createProject } = await import('../src/projects/store.js');
    const folderA = join(root, 'project-a');
    const folderB = join(root, 'project-b');
    mkdirSync(folderA);
    mkdirSync(folderB);
    const projectA = createProject({ name: 'Project A', folders: [folderA] });
    const projectB = createProject({ name: 'Project B', folders: [folderB] });
    model.doStream = async (options) => holdOpenWorkerStream(options.abortSignal);
    const a = await client({ clientKind: 'web', newChatSession: true, projectId: projectA.id });
    const b = await client({ clientKind: 'web', newChatSession: true, projectId: projectB.id });
    const aId = a.getSnapshot().session.id;
    const bId = b.getSnapshot().session.id;
    expect(aId).not.toBe(bId);
    await a.sendMessage({ text: 'Keep A running.', images: [] });
    await b.sendMessage({ text: 'Keep B running.', images: [] });
    await vi.waitFor(() => {
      expect(a.isBusy).toBe(true);
      expect(b.isBusy).toBe(true);
      expect(a.runtime.workspaceRoot).toBe(folderA);
      expect(b.runtime.workspaceRoot).toBe(folderB);
    });
    const aView = await client({ clientKind: 'web', chatSessionId: aId });
    expect(aView.getSnapshot().session.id).toBe(aId);
    expect(aView.isBusy).toBe(true);
    await expect(aView.createNewSession()).rejects.toThrow('Wait for the current run before creating a new chat.');
    aView.stop();
    await vi.waitFor(() => expect(a.isBusy).toBe(false));
    expect(b.isBusy, JSON.stringify(b.getSnapshot().session.entries)).toBe(true);
    expect(b.getSnapshot().session.id).toBe(bId);
    expect(b.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Keep A running.')).toBe(false);
    await b.flushSave();
    const catalog = await b.listSessions();
    expect(catalog.find((session) => session.id === bId)?.running).toBe(true);
    b.stop();
    await vi.waitFor(() => expect(b.isBusy).toBe(false));
  });

  it('restores a closed chat after a host restart and leaves the custodian record alone', async () => {
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const custodianRecord = loadSavedSession(CUSTODIAN_SESSION_ID);
    const owner = await newChat();
    const hostMcp = daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager;
    expect(hostMcp).toBeDefined();
    const ownerId = owner.getSnapshot().session.id;
    await owner.sendMessage({ text: 'Keep the owner conversation.', images: [] });
    await vi.waitFor(() => expect(owner.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant')).toBe(true));
    await owner.flushSave();
    const opened = await client({ newChatSession: true, clientKind: 'web' });
    expect(daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager).toBe(hostMcp);
    const id = opened.getSnapshot().session.id;
    await opened.sendMessage({ text: 'Remember this conversation.', images: [] });
    await vi.waitFor(() =>
      expect(
        opened.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant'),
        JSON.stringify(opened.getSnapshot().session.entries),
      ).toBe(true),
    );
    await opened.flushSave();
    await replaceFixtureHost();
    const restored = await client({ chatSessionId: id, clientKind: 'web' });
    expect(daemonStart.runtimeOptions.mock.lastCall?.[0]?.mcpManager).toBeDefined();
    expect(restored.getSnapshot().session.id).toBe(id);
    expect(
      restored.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Remember this conversation.'),
    ).toBe(true);
    // Each chat is reopened by its own id, and the host restart leaves the custodian
    // record exactly as it was written at the first start.
    const ownerAgain = await openChat(ownerId);
    expect(ownerAgain.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Keep the owner conversation.' }),
    );
    expect(loadSavedSession(CUSTODIAN_SESSION_ID)).toMatchObject({
      id: custodianRecord?.id,
      updatedAt: custodianRecord?.updatedAt,
    });
  });
  it('consumes Team notifications on read while retaining the canonical DM history', async () => {
    const { TeamStore } = await import('../src/team/store.js');
    const { startTeamServer } = await import('../src/team/server.js');
    const { localChannel } = await import('../src/team/session.js');
    const { hashTicket, makeTicket } = await import('../src/team/service.js');
    const teamStore = new TeamStore(join(root, 'fixture-team.db'));
    const now = Date.now();
    teamStore.initHub('fixture-hub', 'fixture-team', 'Fixture', 'Hub', now);
    teamStore.createJoinRequest('jr_fixture', 'Reader', 'fixture-code', now);
    const ticket = makeTicket();
    teamStore.decideJoin('jr_fixture', true, ticket, hashTicket(ticket), now);
    teamStore.confirmTicket('jr_fixture');
    const teamServer = await startTeamServer({ store: teamStore, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.team = {
      role: 'member',
      teamName: 'Fixture',
      memberName: 'Reader',
      hubHost: '127.0.0.1',
      hubPort: Number(new URL(teamServer.url).port),
      teamId: 'fixture-team',
    };
    settings.saveSettings(store);
    settings.saveSecrets({ providers: {}, teamTicket: ticket });
    try {
      await requestHost('settings.reload');
      const viewer = await newChat();
      await localChannel(teamStore, 'Hub').send('Reader', 'Read once; retain history.');
      const built = await registry.createModelTools({
        approve: async () => true,
        onResult: () => {},
        sessionId: viewer.getSnapshot().session.id,
      });
      const execute = async (action: 'list' | 'read', ids?: string[]) =>
        (await built.tools.inbox!.execute!(
          { action, source: 'Team', ...(ids ? { ids } : {}) },
          { toolCallId: 'team-read-fixture', messages: [] },
        )) as { items: Array<{ id: string; content?: { text?: string } }> };
      const pending = await execute('list');
      expect(pending.items).toHaveLength(1);
      expect((await execute('read', [pending.items[0]!.id])).items[0]?.content?.text).toBe('Read once; retain history.');
      expect((await execute('list')).items).toEqual([]);
      expect(teamStore.unreadDmCount('Reader')).toBe(0);
      expect((await localChannel(teamStore, 'Reader').history({ scope: 'dm', peer: 'Hub' })).messages[0]?.body).toBe(
        'Read once; retain history.',
      );
    } finally {
      delete store.team;
      settings.saveSettings(store);
      await requestHost('settings.reload');
      await teamServer.close();
      teamStore.close();
    }
  });

  it('keeps a Telegram notification readable to the custodian it targets, across new chats and host restarts', async () => {
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'UNSET_FIXTURE_INBOX_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const viewer = await newChat();
    await host.receiveTelegramMessage(9001, 'Retain this message as history.');
    type Event = { id: string; source: string; status: string; kind: string };
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as Event[];
      expect(events.some((event) => event.kind === 'inbox.wakeup' && event.status === 'delivered')).toBe(true);
    });
    const executeInbox = async (readerSessionId: string, action: 'list' | 'read', ids?: string[]) => {
      const built = await registry.createModelTools({
        approve: async () => true,
        onResult: () => {},
        sessionId: readerSessionId,
      });
      return (await built.tools.inbox!.execute!(
        { action, source: 'Telegram', ...(ids ? { ids } : {}) },
        { toolCallId: 'fixture-inbox', messages: [] },
      )) as {
        items: Array<{ id: string; from?: string; subject?: string; content?: { messages?: Array<{ text: string }> } }>;
        status?: string;
        unresolved?: string[];
      };
    };
    // The owner's Telegram line belongs to the custodian's conversation: an open chat has no
    // claim on it, and the custodian reads it.
    expect((await executeInbox(viewer.getSnapshot().session.id, 'list')).items).toEqual([]);
    const listed = await executeInbox(CUSTODIAN_SESSION_ID, 'list');
    expect(listed.items).toHaveLength(1);
    // The reader chooses what to open from metadata alone, never from the body.
    expect(listed.items[0]).toMatchObject({ from: 'owner', subject: 'owner message' });
    expect(JSON.stringify(listed)).not.toContain('Retain this message as history.');
    const id = listed.items[0]!.id;
    // A code is derived from what is pending, so a restart neither loses it nor
    // changes it: the custodian opens the same notification afterwards.
    registry = new FixtureRegistry();
    await replaceFixtureHost();
    await newChat();
    expect((await executeInbox(CUSTODIAN_SESSION_ID, 'read', [id])).items[0]?.content?.messages?.[0]?.text).toBe(
      'Retain this message as history.',
    );
    expect((await executeInbox(CUSTODIAN_SESSION_ID, 'list')).items).toEqual([]);
    // The box is not an archive: a code stops resolving the moment its notification
    // is consumed, while the record itself stays in the session history.
    expect(await executeInbox(CUSTODIAN_SESSION_ID, 'read', [id])).toMatchObject({ status: 'invalid', unresolved: [id] });
    const events = (await requestHost('ledger.events')) as Event[];
    expect(events.filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(1);
    expect(events.some((event) => event.kind === 'inbox.delivery-recovery')).toBe(false);
  });

  it('only reminds unread Telegram notifications after five minutes, preserving the cooldown across restarts', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'UNSET_FIXTURE_REMINDER_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    await newChat();
    await host.receiveTelegramMessage(9002, 'Unread reminder fixture.');
    type Event = { id: string; source: string; status: string; kind: string };
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as Event[];
      expect(events.some((event) => event.kind === 'inbox.wakeup' && event.status === 'delivered')).toBe(true);
    });
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    const events = (await requestHost('ledger.events')) as Event[];
    const inboxId = events.find((event) => event.source === 'owner-inbox')!.id;
    const due = Number(reader.getState(`owner-inbox:remind:${inboxId}`));
    reader.close();
    expect(due - Date.now()).toBeGreaterThan(290_000);
    registry = new FixtureRegistry();
    await replaceFixtureHost();
    expect(((await requestHost('ledger.events')) as Event[]).filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(due + 1);
    try {
      registry = new FixtureRegistry();
      await replaceFixtureHost();
      await vi.waitFor(async () =>
        expect(((await requestHost('ledger.events')) as Event[]).filter((event) => event.kind === 'inbox.wakeup')).toHaveLength(2),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('reloads live runtimes after file saves and defers tool reloads while a session is busy', async () => {
    const reload = vi.fn(async (_tools?: boolean) => {});
    fixtureSettingsReload = reload;
    const viewer = await newChat();
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    const store = settings.loadSettings();
    store.theme = 'Light';
    settings.saveSettings(store);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
    model.doStream = async (options) => holdOpenWorkerStream(options.abortSignal);
    const running = viewer.sendMessage({ text: 'Keep this turn open.', images: [] });
    await vi.waitFor(() => expect(viewer.getSnapshot().busy).toBe(true));
    reload.mockClear();
    store.theme = 'Dark';
    settings.saveSettings(store);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(false));
    expect(reload.mock.calls.some(([tools]) => tools === true)).toBe(false);
    viewer.stop();
    await running;
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
  });

  it('reloads live runtimes when another process replaces the model catalog', async () => {
    const reload = vi.fn(async (_tools?: boolean) => {});
    fixtureSettingsReload = reload;
    await newChat();
    for (const filename of ['catalog.ndjson', 'catalog-index.json']) {
      reload.mockClear();
      writeFileSync(join(root, filename), '{}');
      await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(true));
    }
  });

  it('binds web and terminal source labels to the connection and persists them', async () => {
    const web = await newChat({ clientKind: 'web' });
    const terminal = await newChat();
    await web.sendMessage({
      text: 'Browser message.',
      images: [],
      communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: 'fake' } },
    });
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          kind: 'user',
          text: 'Browser message.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('[Host context: owner message via web]');
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain('owner message via Telegram');
    await terminal.sendMessage({ text: 'Terminal message.', images: [] });
    await vi.waitFor(() =>
      expect(terminal.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          kind: 'user',
          text: 'Terminal message.',
          source: 'terminal',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt.at(-1))).toContain('[Host context: owner message via terminal]');
    await web.flushSave();
    const { loadSavedSession } = await import('../src/session-store.js');
    expect(loadSavedSession(web.getSnapshot().session.id)!.entries).toContainEqual(
      expect.objectContaining({
        kind: 'user',
        text: 'Browser message.',
        source: 'web',
      }),
    );
  });

  it('preserves web identity through chat attachments and reconnecting', async () => {
    daemonStart.run.mockResolvedValue({ pid: 9001, startedAt: new Date().toISOString(), workspaceCount: 0, connectedClients: 0 });
    const plain = await newChat();
    const web = await client({ clientKind: 'web', newChatSession: true });
    const otherChat = await client({ clientKind: 'web', newChatSession: true });
    expect(web.getSnapshot().session.id).not.toBe(plain.getSnapshot().session.id);
    expect(otherChat.getSnapshot().session.id).not.toBe(web.getSnapshot().session.id);

    // The chat layer switches chats by opening another attachment, so each surface keeps
    // its own session and nothing is moved between them.
    await otherChat.sendMessage({ text: 'Web after switching.', images: [] });
    await vi.waitFor(() =>
      expect(otherChat.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web after switching.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    await web.sendMessage({ text: 'Web before reconnect.', images: [] });
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web before reconnect.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    await web.flushSave();
    await requestHost('stop', { restart: true });
    await replaceFixtureHost();
    await vi.waitFor(
      () =>
        expect(
          web
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the OpenButler host.')),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    await web.sendMessage({ text: 'Web after reconnect.', images: [] });
    await vi.waitFor(() =>
      expect(web.getSnapshot().session.entries).toContainEqual(
        expect.objectContaining({
          text: 'Web after reconnect.',
          source: 'web',
          turnOutcome: 'completed',
        }),
      ),
    );
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt.at(-1))).toContain('owner message via web');
  }, 10_000);

  it('reads Telegram owner messages through the inbox tool and only sends replies through the explicit tool', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_REPLY_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_REPLY_TOKEN', '123456:fixture-reply-token-value-ok');
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        let result: unknown = true;
        if (method === 'getMe') result = { is_bot: true, username: 'reply_bot' };
        if (method === 'getWebhookInfo') result = {};
        if (method === 'getUpdates')
          result = await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Fixture polling aborted.')), { once: true });
          });
        if (method === 'sendMessage') {
          expect(body.chat_id).toBe('42');
          sent.push(String(body.text));
          result = { message_id: sent.length };
        }
        return new Response(JSON.stringify({ ok: true, result }));
      }),
    );
    try {
      await requestHost('settings.reload');
      const viewer = await newChat();
      const { loadSavedSession } = await import('../src/session-store.js');
      const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
      model.doStream = vi
        .fn()
        .mockImplementationOnce(async (options: { prompt?: unknown }) => {
          const prompt = JSON.stringify(options.prompt);
          expect(prompt).toContain('[Host context: inbox notification]');
          expect(prompt).not.toContain('Inspect this');
          expect(prompt).not.toContain('owner message via Telegram');
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'read',
                toolName: 'inbox',
                input: JSON.stringify({ action: 'read', ids: [await firstInboxId(CUSTODIAN_SESSION_ID, 'Telegram')] }),
              },
            ],

            'tool-calls',
          );
        })
        .mockImplementationOnce(async (options: { prompt?: unknown }) => {
          expect(JSON.stringify(options.prompt)).toContain('Inspect this');
          expect(JSON.stringify(options.prompt)).toContain('owner message via Telegram');
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'send',
                toolName: 'send_message_to_owner',
                input: JSON.stringify({ text: 'Explicit Telegram answer' }),
              },
            ],
            'tool-calls',
          );
        })
        .mockImplementationOnce(async () => textStream('This final text stays in the terminal.'));
      await host.receiveTelegramMessage(1001, 'Inspect this');
      type Event = { id: string; source: string; status: string; payload: Record<string, unknown> };
      await vi.waitFor(
        async () => {
          const events = (await requestHost('ledger.events')) as Event[];
          expect(events.some((event) => event.source === 'owner-inbox' && event.status === 'delivered')).toBe(true);
          expect(events.some((event) => event.source === 'notification' && event.status === 'delivered')).toBe(true);
        },
        { timeout: 8000 },
      );
      expect(sent).toEqual(['Explicit Telegram answer']);
      expect(sent).not.toContain('This final text stays in the terminal.');
      // The run happens in the custodian's conversation, so ordinary assistant text stays
      // there and never reaches the owner's Telegram chat on its own.
      await vi.waitFor(() =>
        expect(
          loadSavedSession(CUSTODIAN_SESSION_ID)?.entries.some(
            (entry) => entry.kind === 'assistant' && entry.text === 'This final text stays in the terminal.',
          ),
        ).toBe(true),
      );
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'This final text stays in the terminal.'),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);
  it('reconnects shared and isolated TUI sessions after an intentional restart', async () => {
    daemonStart.run.mockResolvedValue({ pid: 9001, startedAt: new Date().toISOString(), workspaceCount: 0, connectedClients: 0 });
    const shared = await newChat();
    const isolated = await client({ isolatedSession: true });
    const sharedId = shared.getSnapshot().session.id;
    const isolatedId = isolated.getSnapshot().session.id;
    for (const attached of [shared, isolated]) {
      await attached.sendMessage({ text: 'Preserve this session during restart.', images: [] });
      await vi.waitFor(() =>
        expect(
          attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response'),
        ).toBe(true),
      );
      await attached.flushSave();
    }
    await requestHost('stop', { restart: true });
    for (const attached of [shared, isolated])
      await vi.waitFor(() =>
        expect(
          attached
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('OpenButler host restarting')),
        ).toBe(true),
      );
    await replaceFixtureHost();
    for (const attached of [shared, isolated])
      await vi.waitFor(
        () =>
          expect(
            attached
              .getSnapshot()
              .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the OpenButler host.')),
          ).toBe(true),
        { timeout: 5_000, interval: 25 },
      );
    expect(shared.getSnapshot().session.id).toBe(sharedId);
    expect(isolated.getSnapshot().session.id).toBe(isolatedId);
    expect(shared.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Preserve this session during restart.' }),
    );
    expect(isolated.getSnapshot().session.entries).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Fixture response' }));
  }, 10_000);

  it('hands a surface the chat it left off in after a restart with no client connected', async () => {
    const attached = await newChat();
    const id = attached.getSnapshot().session.id;
    await attached.sendMessage({ text: 'Resume this workspace after restart.', images: [] });
    await vi.waitFor(() =>
      expect(attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    await attached.flushSave();
    attached.close();
    await requestHost('stop', { restart: true });
    await replaceFixtureHost();
    // A surface starts by resuming the chat the owner left off in.
    const { resumeChatAttach } = await import('../src/daemon-client.js');
    expect(resumeChatAttach('terminal')).toEqual({ clientKind: 'terminal', chatSessionId: id });
    const restored = await openChat(id);
    expect(restored.getSnapshot().session.id).toBe(id);
    expect(restored.getSnapshot().session.entries).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'Resume this workspace after restart.' }),
    );
  });

  it('keeps an explicit stop stopped instead of restarting it from an attached client', async () => {
    const attached = await newChat();
    await requestHost('stop');
    await vi.waitFor(() =>
      expect(
        attached.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('OpenButler host stopping')),
      ).toBe(true),
    );
    await host.close();
    await vi.waitFor(() =>
      expect(
        attached
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('The OpenButler host stopped.')),
      ).toBe(true),
    );
    expect(daemonStart.run).not.toHaveBeenCalled();
  });

  it('reattaches the existing client and restores its saved session after an unexpected host disconnect', async () => {
    const attached = await newChat();
    const sessionId = attached.getSnapshot().session.id;
    await attached.sendMessage({ text: 'Persist this task before disconnect.', images: [] });
    await vi.waitFor(
      () =>
        expect(
          attached.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response'),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    await attached.flushSave();

    await replaceFixtureHost();

    await vi.waitFor(
      () =>
        expect(
          attached
            .getSnapshot()
            .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Reconnected to the OpenButler host.')),
        ).toBe(true),
      { timeout: 5_000, interval: 25 },
    );
    expect(attached.getSnapshot().session.id).toBe(sessionId);
    expect(daemonStart.run).not.toHaveBeenCalled();
    expect(
      attached
        .getSnapshot()
        .session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Persist this task before disconnect.'),
    ).toBe(true);
  }, 10_000);

  it('runs the real --c CLI entry through an isolated host session without contacting a model provider', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.providers.fixture = { enabled: true, keys: ['fixture-only-key'], npm: '@ai-sdk/openai-compatible', url: 'http://127.0.0.1:1/v1' };
    store.providerOrder = ['fixture'];
    store.defaultProvider = 'fixture';
    store.defaultModel = 'fixture';
    settings.saveSettings(store);
    const memory = await import('../src/memory-index.js');
    const modelRoot = join(root, 'models', memory.MEMORY_EMBEDDING_MODEL, memory.MEMORY_EMBEDDING_REVISION);
    mkdirSync(join(modelRoot, 'onnx'), { recursive: true });
    // The CLI checks cache metadata; inference is supplied only by this host's local model fixture.
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'])
      writeFileSync(join(modelRoot, file), 'fixture-only cache metadata');
    const shared = await newChat();
    const sharedId = shared.getSnapshot().session.id;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
      const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
      const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), '--workspace', root, '--c', 'A fixture request'], {
        cwd: root,
        env: { ...process.env, OPENBUTLER_DATA_DIR: root },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        rejectChild(new Error('CLI fixture timed out.'));
      }, 8000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolveChild({ code, stdout, stderr });
      });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Fixture response');
    expect(shared.getSnapshot().session.id).toBe(sharedId);
    expect(shared.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('starts without default work and isolates one-shot sessions while preserving a shared session across detach', async () => {
    expect(host.getStatus().schedules).toBe(0);
    const shared = await newChat();
    const sharedId = shared.getSnapshot().session.id;
    shared.addEntry({ kind: 'notice', text: 'Shared fixture session' });
    await vi.waitFor(() => expect(shared.getSnapshot().session.entries).toHaveLength(1));
    const isolated = await client({ isolatedSession: true });
    expect(isolated.getSnapshot().session.id).not.toBe(sharedId);
    const longAnswer = 'Large sample café naïve 👋 output\n'.repeat(4000);
    model.doStream = async () => textStream(longAnswer);
    await isolated.sendMessage({ text: 'Isolated fixture request', images: [] });
    await vi.waitFor(() => {
      expect(isolated.getSnapshot().busy).toBe(false);
      expect(isolated.getSnapshot().session.entries.find((entry) => entry.kind === 'assistant')).toMatchObject({
        kind: 'assistant',
        text: longAnswer,
      });
    });
    expect(shared.getSnapshot().session.entries).toMatchObject([{ kind: 'notice', text: 'Shared fixture session' }]);
    await shared.close();
    const reconnected = await openChat(sharedId);
    expect(reconnected.getSnapshot().session.id).toBe(sharedId);
    expect(reconnected.getSnapshot().session.entries).toHaveLength(1);
  }, 10_000);

  it('preserves pending approvals across client detach and rejects a stale decision before logging the actual execution', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', detail: 'fixture result' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementationOnce(async () => textStream('Approved fixture complete'));
    const first = await newChat();
    const chatId = first.getSnapshot().session.id;
    await first.sendMessage({ text: 'Inspect fixture', images: [] });
    await vi.waitFor(() => expect(first.getSnapshot().pendingApprovalId).toBeTruthy());
    const id = first.getSnapshot().pendingApprovalId!;
    await first.close();
    const restored = await openChat(chatId);
    expect(restored.getSnapshot().pendingApprovalId).toBe(id);
    restored.approveToolCall('allow', 'wrong-request-id');
    await requestHost('status');
    expect(restored.getSnapshot().pendingApprovalId).toBe(id);
    expect(execute).not.toHaveBeenCalled();
    restored.approveToolCall('allow', id);
    await vi.waitFor(() =>
      expect(
        restored.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Approved fixture complete'),
      ).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const actions = (await requestHost('ledger.actions')) as Array<{ requestId: string; state: string }>;
    expect(actions).toContainEqual(expect.objectContaining({ requestId: id, state: 'completed' }));
  }, 10_000);

  it('hands a stamped thinking duration to the client instead of losing it in the patch', async () => {
    // The publish diff treated a duration-only change as a text append with an
    // empty delta, and the client rebuilt the entry from kind and text alone. The
    // server had the duration while the transcript kept a bare "Thought" label.
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            { type: 'reasoning-start', id: 'reasoning' },
            { type: 'reasoning-delta', id: 'reasoning', delta: 'Think before the tool.' },
            { type: 'reasoning-end', id: 'reasoning' },
            { type: 'tool-call', toolCallId: 'inspect-duration', toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Fixture complete.'));
    const viewer = await newChat();
    await viewer.sendMessage({ text: 'Inspect fixture', images: [] });
    await vi.waitFor(() => expect(viewer.getSnapshot().busy).toBe(false));
    const blocks = viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'reasoning', text: 'Think before the tool.' });
    expect((blocks[0] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
  }, 10_000);

  it('routes a model question through session.answer, ignores a stale id, and clears it after the answer', async () => {
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'ask-1',
              toolName: 'question',
              input: '{"question":"Which environment?","options":["Staging","Production"]}',
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Deploying to Staging.'));
    const asker = await newChat();
    await asker.sendMessage({ text: 'Deploy fixture', images: [] });
    await vi.waitFor(() => expect(asker.getSnapshot().pendingQuestion).not.toBeNull());
    const pending = asker.getSnapshot().pendingQuestion!;
    expect(pending.question).toBe('Which environment?');
    asker.answerQuestion(null, 'stale-question-id');
    await requestHost('status');
    expect(asker.getSnapshot().pendingQuestion?.id).toBe(pending.id);
    asker.answerQuestion('Staging', pending.id);
    await vi.waitFor(() =>
      expect(
        asker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Deploying to Staging.'),
      ).toBe(true),
    );
    expect(asker.getSnapshot().pendingQuestion).toBeNull();
  }, 10_000);

  it('resolves a command name through the registry and refuses one the registry does not know', async () => {
    const attached = await newChat();
    if (!attached.command) throw new Error('The client carries no commands to the host.');
    const unknownCommands = () =>
      attached.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice' && entry.text.includes('Unknown command.')).length;

    // A name outside the vocabulary never reaches a session.
    await attached.command('/not-a-command');
    await vi.waitFor(() => expect(unknownCommands()).toBe(1));

    // A surface command has no host effect, so it is refused the same way.
    await attached.command('/settings');
    await vi.waitFor(() => expect(unknownCommands()).toBe(2));

    // /compact normalizes to the request the host already implements: it is
    // accepted, and the session's own compaction answers for it.
    await attached.command('/compact');
    await vi.waitFor(() =>
      expect(
        attached
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('no conversation to compact')),
      ).toBe(true),
    );
    expect(unknownCommands()).toBe(2);
  }, 10_000);

  it('rejoins an active isolated session instead of copying its saved transcript and losing the live approval', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'isolated-inspect', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementationOnce(async () => textStream('Recovered isolated run'));
    const idle = await newChat();
    const idleId = idle.getSnapshot().session.id;
    const isolated = await client({ isolatedSession: true });
    const sessionId = isolated.getSnapshot().session.id;
    await isolated.sendMessage({ text: 'Isolated inspection', images: [] });
    await vi.waitFor(() => expect(isolated.getSnapshot().pendingApprovalId).toBeTruthy());
    const requestId = isolated.getSnapshot().pendingApprovalId!;
    await isolated.close();
    // Seeing that live run again is a chat-layer attachment, not a surface being moved.
    const viewer = await client({ chatSessionId: sessionId, clientKind: 'web' });
    expect(viewer.getSnapshot().session.id).toBe(sessionId);
    expect(viewer.getSnapshot().pendingApprovalId).toBe(requestId);
    viewer.approveToolCall('allow', requestId);
    await vi.waitFor(() =>
      expect(
        viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Recovered isolated run'),
      ).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    // The other chat never picked up the isolated run's entries.
    const idleAgain = await openChat(idleId);
    expect(idleAgain.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('reports a failed source activation separately from saving the task definition', async () => {
    const task = {
      id: 'missing-source',
      name: 'Requested filesystem task',
      enabled: true,
      workspaceRoot: root,
      instruction: 'Notify me about selected file changes.',
      trigger: { adapter: 'filesystem', options: { path: join(root, 'missing-directory') } },
    };
    const result = (await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root })) as {
      status: string;
      saved: boolean;
      runtime: { state: string };
    };
    expect(result).toMatchObject({ status: 'error', saved: true, runtime: { state: 'error' } });
  });

  it('routes an explicit task through the same model and request-bound approval gate without granting native tool auto-approval', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Native-auto fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute,
    });
    // Prompt-aware rather than order-dependent: a delegated approval also wakes the
    // custodian, and an order-keyed mock would hand this run's step to that turn.
    let taskSteps = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      if (!prompt.includes('Inspect once when requested.')) return textStream('Custodian acknowledged.');
      taskSteps += 1;
      if (taskSteps === 1)
        return stream([{ type: 'tool-call', toolCallId: 'task-inspect', toolName: 'inspect', input: '{}' }], 'tool-calls');
      return textStream('Task fixture finished');
    });
    const task = {
      id: 'explicit',
      name: 'Requested task',
      enabled: true,
      workspaceRoot: root,
      instruction: 'Inspect once when requested.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    const taskClient = await client({ scheduleId: task.id });
    await vi.waitFor(() => expect(taskClient.getSnapshot().pendingApprovalId).toBeTruthy());
    expect(execute).not.toHaveBeenCalled();
    // The attached client can still decide it: delegation adds the custodian as the
    // one who normally does, it does not take the client's own view away.
    taskClient.approveToolCall('allow', taskClient.getSnapshot().pendingApprovalId!);
    await vi.waitFor(() =>
      expect(
        taskClient.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Task fixture finished'),
      ).toBe(true),
    );
    const events = (await requestHost('ledger.events')) as Array<{ id: string; source: string; status: string }>;
    const triggered = events.find((event) => event.source === 'schedule:manual');
    const actions = (await requestHost('ledger.actions')) as Array<{ eventId: string; state: string }>;
    expect(actions).toContainEqual(expect.objectContaining({ eventId: triggered?.id, state: 'completed' }));
    expect(execute).toHaveBeenCalledTimes(1);
    // An unattended run does not push to the owner: the request and the decision
    // live in the ledger and the custodian's inbox, not on the phone.
    expect(events.some((event) => event.source === 'notification' && event.status === 'delivered')).toBe(false);
    expect(events.some((event) => event.source === 'agent-inbox')).toBe(true);
  }, 10_000);

  it('wakes the origin session with a run-numbered turn and records durable runtime', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Origin run finished'));
    const origin = await newChat();
    const originId = origin.getSnapshot().session.id;
    const task = {
      id: 'wake-origin',
      name: 'Wake me here',
      enabled: true,
      workspaceRoot: root,
      originSessionId: originId,
      instruction: 'Say the report.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    await vi.waitFor(() =>
      expect(origin.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Origin run finished')).toBe(
        true,
      ),
    );
    const wake = origin
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.startsWith('Schedule "Wake me here"'))!;
    expect(wake).toContain('This is run #1. No previous run.');
    expect(wake).not.toContain('LATE:');
    expect(wake).toContain('Trigger facts (untrusted observations');
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string; runtime: Record<string, unknown> }>;
    };
    expect(list.schedules.find((candidate) => candidate.id === task.id)?.runtime).toMatchObject({
      runCount: 1,
      lastResult: 'completed',
      lastReport: 'Origin run finished',
    });
    const log = (await requestHost('schedule.manage', { input: { action: 'log', scheduleId: task.id }, workspaceRoot: root })) as {
      runs: Array<{ kind: string; status: string }>;
    };
    expect(log.runs).toContainEqual(expect.objectContaining({ kind: 'schedule.requested', status: 'delivered' }));
  }, 10_000);

  it('marks a past one-shot as LATE on wake instead of skipping it', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Late report'));
    const origin = await newChat();
    const past = new Date(Date.now() - 3_600_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
    const task = {
      id: 'late-once',
      name: 'Late once',
      enabled: true,
      workspaceRoot: root,
      originSessionId: origin.getSnapshot().session.id,
      instruction: 'Report briefly.',
      trigger: { adapter: 'at', options: { at: local } },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await vi.waitFor(() =>
      expect(origin.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Late report')).toBe(true),
    );
    const wake = origin
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.startsWith('Schedule "Late once"'))!;
    expect(wake).toMatch(/LATE: scheduled for .* \(1h \d+m late\)/);
  }, 10_000);

  it('falls back to the task session with provenance when the origin session is gone', async () => {
    model.doStream = vi.fn().mockImplementationOnce(async () => textStream('Fallback finished'));
    const task = {
      id: 'wake-fallback',
      name: 'Fallen back',
      enabled: true,
      workspaceRoot: root,
      originSessionId: 'dead-beef-session',
      instruction: 'Say the report.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });
    const taskClient = await client({ scheduleId: task.id });
    await vi.waitFor(() =>
      expect(
        taskClient.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fallback finished'),
      ).toBe(true),
    );
    const wake = taskClient
      .getSnapshot()
      .session.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []))
      .find((text) => text.includes('Schedule "Fallen back"'))!;
    expect(wake.startsWith('Created in session dead-beef-session, which no longer exists.')).toBe(true);
    expect(wake).toContain('This is run #1. No previous run.');
  }, 10_000);

  it('defaults a tool-created task to the calling session for wake affinity', async () => {
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-add',
              toolName: 'schedule',
              input: JSON.stringify({
                action: 'add',
                schedule: {
                  id: 'threaded',
                  name: 'Threaded',
                  enabled: true,
                  workspaceRoot: root,
                  instruction: 'Do the thing.',
                  trigger: { adapter: 'manual', options: {} },
                },
              }),
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementationOnce(async () => textStream('Task created'));
    const caller = await newChat();
    await caller.sendMessage({ text: 'Create a schedule', images: [] });
    // Same-workspace task management runs silent: no approval card.
    await vi.waitFor(() =>
      expect(caller.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Task created')).toBe(true),
    );
    expect(caller.getSnapshot().pendingApprovalId).toBeNull();
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string; originSessionId: string }>;
    };
    expect(list.schedules.find((candidate) => candidate.id === 'threaded')?.originSessionId).toBe(caller.getSnapshot().session.id);
  }, 10_000);

  it('preserves an explicit separate schedule session and reuses it across runs and host restarts', async () => {
    const caller = await newChat();
    const callerId = caller.getSnapshot().session.id;
    const schedule = {
      id: 'separate-persistent',
      name: 'Separate persistent',
      enabled: true,
      workspaceRoot: root,
      originSessionId: '',
      instruction: 'Report the run.',
      trigger: { adapter: 'manual', options: {} },
    };
    const built = await (await registryAt(root)).createModelTools({ approve: async () => true, onResult: () => {}, sessionId: callerId });
    await built.tools.schedule!.execute!({ action: 'add', schedule }, { toolCallId: 'add-separate', messages: [] });
    const settings = await import('../src/settings.js');
    expect(settings.getSettingsPath()).toBe(join(root, 'settings.yaml'));
    expect(settings.loadSettings().schedules.find((item) => item.id === schedule.id)?.originSessionId).toBe('');
    let scheduled = await client({ scheduleId: schedule.id });
    const scheduleSessionId = scheduled.getSnapshot().session.id;
    expect(scheduleSessionId).not.toBe(callerId);
    model.doStream = vi.fn(async () => textStream('Persistent schedule report.'));
    const run = async (number: number) => {
      await requestHost('schedule.manage', { input: { action: 'run', scheduleId: schedule.id }, workspaceRoot: root });
      await vi.waitFor(async () => {
        const result = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
          schedules: Array<{ id: string; runtime: { runCount: number; status: string } }>;
        };
        const state = result.schedules.find((item) => item.id === schedule.id)!.runtime;
        expect(state.runCount).toBe(number);
        expect(state.status).toBe('idle');
      });
      expect(scheduled.getSnapshot().session.id).toBe(scheduleSessionId);
      expect(
        scheduled.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text.includes(`This is run #${number}.`)),
      ).toBe(true);
    };
    await run(1);
    await run(2);
    expect(caller.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'schedule')).toBe(false);
    registry = new FixtureRegistry();
    await replaceFixtureHost();
    scheduled = await client({ scheduleId: schedule.id });
    await run(3);
    expect(
      scheduled.getSnapshot().session.entries.filter((entry) => entry.kind === 'assistant' && entry.text === 'Persistent schedule report.'),
    ).toHaveLength(3);
  }, 10_000);

  it.each(['', 'existing-origin'])('preserves the existing schedule affinity %j when a tool update omits it', async (originSessionId) => {
    const caller = await newChat();
    const schedule = {
      id: 'preserve-affinity',
      name: 'Preserve affinity',
      enabled: true,
      workspaceRoot: root,
      originSessionId,
      instruction: 'Original instruction.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule }, workspaceRoot: root });
    const { originSessionId: _origin, ...updated } = schedule;
    const built = await (
      await registryAt(root)
    ).createModelTools({
      approve: async () => true,
      onResult: () => {},
      sessionId: caller.getSnapshot().session.id,
    });
    await built.tools.schedule!.execute!(
      { action: 'update', schedule: { ...updated, instruction: 'Updated instruction.' } },
      { toolCallId: 'update-affinity', messages: [] },
    );
    const settings = await import('../src/settings.js');
    const saved = settings.loadSettings().schedules.find((item) => item.id === schedule.id);
    expect(saved?.originSessionId).toBe(originSessionId);
    expect(saved?.instruction).toBe('Updated instruction.');
  });

  it('generates a task id when add omits it', async () => {
    const result = (await requestHost('schedule.manage', {
      input: {
        action: 'add',
        schedule: {
          name: 'Nightly DB Check!',
          enabled: true,
          workspaceRoot: root,
          instruction: 'Check and report.',
          trigger: { adapter: 'manual', options: {} },
        },
      },
      workspaceRoot: root,
    })) as { status: string; schedule: { id: string; name: string } };
    expect(result.status).toBe('completed');
    expect(result.schedule.id).toMatch(/^nightly-db-check-[0-9a-f]{4}$/);
    const list = (await requestHost('schedule.manage', { input: { action: 'list' }, workspaceRoot: root })) as {
      schedules: Array<{ id: string }>;
    };
    expect(list.schedules.map((task) => task.id)).toContain(result.schedule.id);
  });

  it('persists background worker lineage and notes to durable state when it finishes', async () => {
    let workerStep = 0;
    let spawns = 0;
    // Bounded by construction: snapshot sync lags a fast mock loop, so the
    // mock must terminate from its own counters, never from snapshots.
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) {
        workerStep += 1;
        if (workerStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'w-note',
                toolName: 'parent_message',
                input: JSON.stringify({ text: 'Milestone one done.' }),
              },
            ],
            'tool-calls',
          );
        return textStream('WORKER-REPORT: all done.');
      }
      spawns += 1;
      if (spawns >= 2) return textStream('PARENT-DONE');
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `p-spawn-${spawns}`,
            toolName: 'subagent',
            input: JSON.stringify({ task: 'Do it.', mode: 'executor', background: true }),
          },
        ],
        'tool-calls',
      );
    });
    const viewerEntries = () => viewer.getSnapshot().session.entries as Array<{ kind: string; session?: unknown; result?: unknown }>;
    const viewer = await newChat();
    const parentId = viewer.getSnapshot().session.id;
    await viewer.sendMessage({ text: 'Spawn the worker.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewerEntries()
          .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
          .find((session): session is string => typeof session === 'string'),
      ).toBeTruthy(),
    );
    const workerId = viewerEntries()
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .find((session): session is string => typeof session === 'string')!;
    const workerView = await client({ workerSessionId: workerId });
    await vi.waitFor(() => expect(workerView.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    // The durable artifacts a post-restart poll reads: lineage record plus notes.
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const { readWorkerOutbox, readWorkerRecord } = await import('../src/worker-records.js');
    const ledger = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      expect(readWorkerRecord(ledger, workerId)).toMatchObject({
        parentSessionId: parentId,
        mode: 'executor',
        background: true,
        finished: true,
      });
      expect(readWorkerOutbox(ledger, workerId).notes).toEqual(['Milestone one done.']);
    } finally {
      ledger.close();
    }
  }, 20_000);

  it('drives the custodian from Telegram and leaves an open chat untouched', async () => {
    const settings = await import('../src/settings.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await newChat();
    const openChatId = viewer.getSnapshot().session.id;

    const prompts: string[] = [];
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'read',
              toolName: 'inbox',
              input: JSON.stringify({ action: 'read', ids: [await firstInboxId(CUSTODIAN_SESSION_ID, 'Telegram')] }),
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementation(async (options: { prompt?: unknown }) => {
        prompts.push(JSON.stringify(options.prompt));
        return textStream('Fixture response');
      });

    await host.receiveTelegramMessage(11, 'Hello from Telegram');

    await vi.waitFor(() =>
      expect(
        loadSavedSession(CUSTODIAN_SESSION_ID)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response'),
      ).toBe(true),
    );
    const custodianThread = loadSavedSession(CUSTODIAN_SESSION_ID)?.entries ?? [];
    // The inbox wake signal joins the custodian's own thread as a user entry…
    expect(custodianThread.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
    // …while the actual Telegram text only surfaces through an explicit inbox read.
    expect(prompts.some((prompt) => prompt.includes('Hello from Telegram') && prompt.includes('owner message via Telegram'))).toBe(true);
    // The chat the owner has open is a different conversation and stays empty.
    expect(viewer.getSnapshot().session.id).toBe(openChatId);
    expect(viewer.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('has no reset command on Telegram: /clear and /new never open a chat', async () => {
    const settings = await import('../src/settings.js');
    const { listSavedSessions, loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    expect(loadSavedSession(CUSTODIAN_SESSION_ID)?.id).toBe(CUSTODIAN_SESSION_ID);
    const chatsBefore = listSavedSessions().length;

    // The chat layer belongs to the interfaces the owner is looking at. Telegram is the
    // custodian's own channel, so the reset command does not exist there: both spellings
    // are ordinary text and neither opens a chat.
    await host.receiveTelegramMessage(31, '/clear');
    await host.receiveTelegramMessage(32, '/new');

    expect(listSavedSessions()).toHaveLength(chatsBefore);
    expect(loadSavedSession(CUSTODIAN_SESSION_ID)?.id).toBe(CUSTODIAN_SESSION_ID);
  }, 10_000);

  it('routes every inbound message to the custodian even when a legacy binding and correlation row exist', async () => {
    const settings = await import('../src/settings.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const chat = await newChat();
    const chatId = chat.getSnapshot().session.id;
    // A machine upgraded from the binding era still carries both rows that used
    // to decide the channel: a fixed binding and a per-message origin.
    const writer = new ActivityLedger(join(root, 'state.db'));
    writer.setState('telegram:binding:2', chatId);
    writer.setState('telegram:message:1:77', chatId);
    writer.close();

    model.doStream = vi.fn(async () => textStream('Custodian answer'));
    await host.receiveTelegramMessage(11, 'Hello after the upgrade');

    await vi.waitFor(() =>
      expect(
        loadSavedSession(CUSTODIAN_SESSION_ID)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Custodian answer'),
      ).toBe(true),
    );
    // The chat named by the stale rows never ran the message.
    expect(chat.getSnapshot().session.entries).toEqual([]);
  }, 10_000);

  it('never writes a telegram binding row for an inbound message', async () => {
    const settings = await import('../src/settings.js');
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    model.doStream = vi.fn(async () => textStream('Custodian answer'));

    await host.receiveTelegramMessage(12, 'One line, one target');
    // Wait until the message has actually been through the host, so the assertion
    // below cannot pass merely because nothing ran yet.
    await vi.waitFor(() =>
      expect(loadSavedSession(CUSTODIAN_SESSION_ID)?.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true),
    );

    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      expect(reader.getState('telegram:binding:2')).toBeNull();
    } finally {
      reader.close();
    }
  }, 10_000);

  it('sends owner messages without a session label', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_LABEL_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_LABEL_TOKEN', '123456:fixture-label-token-value-ok');
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        let result: unknown = true;
        if (method === 'getMe') result = { is_bot: true, username: 'label_bot' };
        if (method === 'getWebhookInfo') result = {};
        if (method === 'getUpdates')
          result = await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Fixture polling aborted.')), { once: true });
          });
        if (method === 'sendMessage') {
          sent.push(String(body.text));
          result = { message_id: sent.length };
        }
        return new Response(JSON.stringify({ ok: true, result }));
      }),
    );
    try {
      await requestHost('settings.reload');
      expect(fixtureOwnerTool).toBeDefined();
      await fixtureOwnerTool!.execute!({ text: 'Straight from the custodian' });
      // One author writes on this channel, so nothing disambiguates the sender.
      expect(sent).toEqual(['Straight from the custodian']);
      // And no reply-correlation row is left behind for the sent message (the stub
      // transport reports message_id 1), because quoting it addresses nobody.
      const { ActivityLedger } = await import('../src/activity-ledger.js');
      const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
      try {
        expect(reader.getState('telegram:message:42:1')).toBeNull();
      } finally {
        reader.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  it('gives the chat runtime no owner-message tool at all', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const chat = await newChat();
    const offered: string[][] = [];
    const prompts: string[] = [];
    model.doStream = vi.fn(async (options: { tools?: unknown; prompt?: unknown }) => {
      offered.push(offeredToolNames(options));
      prompts.push(JSON.stringify(options.prompt));
      return textStream('Chat answer');
    });

    await chat.sendMessage({ text: 'Say something', images: [] });
    await vi.waitFor(() => expect(offered.length).toBeGreaterThan(0));

    // Absence, not refusal: the name is never offered, so the model cannot spend a
    // call learning that it is not allowed. `inbox` is the control proving the
    // tool list itself arrived.
    expect(offered[0]).not.toContain('send_message_to_owner');
    expect(offered[0]).toContain('inbox');
    // And the prompt does not describe the channel either: telling a runtime not
    // to use a capability it does not have only plants the idea.
    expect(prompts[0]).not.toContain('send_message_to_owner');
    // A chat's base is the neutral agent policy: it names the head without
    // claiming to be it, and no role note is appended under a channel heading.
    expect(prompts[0]).toContain('## Where you sit');
    expect(prompts[0]).not.toContain("You are the machine's custodian");
    expect(prompts[0]).not.toContain('## Active channel');
    // The clock rule is environment, not role, so every layer reads it.
    expect(prompts[0]).toContain('Every tool result is stamped');
  }, 10_000);

  it('gives the custodian runtime the owner-message tool', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const offered: string[][] = [];
    const prompts: string[] = [];
    model.doStream = vi.fn(async (options: { tools?: unknown; prompt?: unknown }) => {
      offered.push(offeredToolNames(options));
      prompts.push(JSON.stringify(options.prompt));
      return textStream('Custodian answer');
    });

    await host.receiveTelegramMessage(41, 'Answer me');
    await vi.waitFor(() => expect(offered.length).toBeGreaterThan(0));

    expect(offered[0]).toContain('send_message_to_owner');
    // The custodian is the one runtime whose prompt is written for the head itself.
    expect(prompts[0]).toContain("You are the machine's custodian: the head of the agent hierarchy");
    // Its own text is the base rather than a note under the agent policy: one
    // identity, and no section that only the neutral policy carries.
    expect(prompts[0]).not.toContain('## Where you sit');
    expect(prompts[0]).not.toContain('## Active channel');
    // The clock rule survives the base switch because it lives with the environment.
    expect(prompts[0]).toContain('Every tool result is stamped');
  }, 10_000);

  it('delivers the setup test message to the paired owner chat and refuses it before pairing', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_SETUP_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_SETUP_TOKEN', '123456:fixture-setup-token-value-ok');
    const sent: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'setup_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(body);
        result = { message_id: sent.length };
      }
      if (method === 'getUpdates') {
        result = await new Promise<unknown[]>((_resolveUpdates, rejectUpdates) => {
          init?.signal?.addEventListener('abort', () => rejectUpdates(new Error('Fixture polling aborted.')), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const reloaded = (await requestHost('settings.reload', {})) as { telegram?: { state: string; paired: boolean } | null };
      expect(reloaded.telegram?.state).toBe('polling');
      await expect(requestHost('telegram.test', { message: 'setup says hi' })).resolves.toEqual({ delivered: true });
      expect(sent).toContainEqual(expect.objectContaining({ chat_id: '42', parse_mode: 'HTML' }));
      expect(String(sent[0]?.text)).toContain('setup says hi');
      await expect(requestHost('telegram.test', {})).resolves.toEqual({ delivered: true });
      expect(sent.at(-1)).toMatchObject({ chat_id: '42' });

      const unpaired = settings.defaultSettings();
      unpaired.telegram = { enabled: true, tokenEnv: 'FTG_SETUP_TOKEN', workspaceRoot: root };
      settings.saveSettings(unpaired);
      await requestHost('settings.reload', {});
      await expect(requestHost('telegram.test', {})).rejects.toThrow(/not paired yet/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('stops the running turn from Telegram while queued messages stay queued', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const viewer = await newChat();

    model.doStream = vi.fn().mockImplementationOnce(async () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'long' });
            controller.enqueue({ type: 'text-delta', id: 'long', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'long', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    });
    await host.receiveTelegramMessage(21, 'First long request');
    // The long turn is the custodian's: it starts the moment the model is asked for it.
    await vi.waitFor(() => expect(model.doStream).toHaveBeenCalledTimes(1));

    await host.receiveTelegramMessage(22, 'Second queued request');
    model.doStream = vi.fn(async () => textStream('Fixture response'));
    await host.receiveTelegramMessage(23, '/stop');

    const custodianEntries = () => loadSavedSession(CUSTODIAN_SESSION_ID)?.entries ?? [];
    await vi.waitFor(() =>
      expect(custodianEntries().some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(true),
    );
    // The queued inbox message survives the stop: still present in the owner inbox ledger…
    type InboxEvent = { source: string; status: string; payload: { text?: unknown } };
    const events = (await requestHost('ledger.events')) as InboxEvent[];
    const inboxTexts = events.filter((event) => event.source === 'owner-inbox').map((event) => event.payload.text);
    expect(inboxTexts).toContain('First long request');
    expect(inboxTexts).toContain('Second queued request');
    // …and its wake still ran on the custodian's thread after the stop.
    expect(custodianEntries().some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
    // The chat the owner had open receives none of it.
    expect(viewer.getSnapshot().session.entries).toEqual([]);
  }, 15_000);

  it('lists the last 10 chats from Telegram with /sessions', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_SESSIONS_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_SESSIONS_TOKEN', '123456:fixture-sessions-token-ok');
    const sent: string[] = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'sessions_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(String(body.text));
        result = { message_id: sent.length };
      }
      if (method === 'getUpdates') {
        result = await new Promise<unknown[]>((_resolveUpdates, rejectUpdates) => {
          init?.signal?.addEventListener('abort', () => rejectUpdates(new Error('Fixture polling aborted.')), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await requestHost('settings.reload', {});
      // The recent-chat list is chats: the custodian is written on its own surface and would
      // not appear, so this opens the chat the owner would have open while working.
      const viewer = await client({ newChatSession: true, clientKind: 'web' });
      await viewer.sendMessage({ text: 'Hello from the terminal', images: [] });
      await vi.waitFor(() =>
        expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
          true,
        ),
      );
      await viewer.flushSave();
      await host.receiveTelegramMessage(41, '/sessions');
      await vi.waitFor(() => expect(sent.some((text) => /Recent chats:\n1\. .+ — \d{4}-\d{2}-\d{2}/.test(text))).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('removes the reply keyboard when the owner chat is unpaired', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_FAREWELL_TOKEN', workspaceRoot: root, chatId: '42', userId: '7' };
    settings.saveSettings(store);
    vi.stubEnv('FTG_FAREWELL_TOKEN', '123456:fixture-farewell-token-ok');
    const sent: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'farewell_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'sendMessage') {
        sent.push(body);
        result = { message_id: sent.length };
      }
      if (method === 'getUpdates') {
        result = await new Promise<unknown[]>((_resolveUpdates, rejectUpdates) => {
          init?.signal?.addEventListener('abort', () => rejectUpdates(new Error('Fixture polling aborted.')), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await requestHost('settings.reload', {});
      const unpaired = settings.defaultSettings();
      unpaired.telegram = { enabled: true, tokenEnv: 'FTG_FAREWELL_TOKEN', workspaceRoot: root };
      settings.saveSettings(unpaired);
      await requestHost('settings.reload', {});
      const farewell = sent.find(
        (body) =>
          typeof body.reply_markup === 'object' &&
          body.reply_markup !== null &&
          (body.reply_markup as Record<string, unknown>).remove_keyboard === true,
      );
      expect(farewell).toMatchObject({ chat_id: '42' });
      expect(String(farewell?.text)).toMatch(/disconnected/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('lets the custodian steer a live worker and refuses the same call from a chat', async () => {
    const settings = await import('../src/settings.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_STEER_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const viewer = await newChat();
    const worker = await client({ isolatedSession: true });
    await worker.sendMessage({ text: 'Worker standing by.', images: [] });
    await vi.waitFor(() =>
      expect(worker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Fixture response')).toBe(
        true,
      ),
    );
    await worker.flushSave();
    const workerId = worker.getSnapshot().session.id;

    // The custodian learns about the owner's request from its inbox, then steers the worker.
    // The Telegram text only enters its prompt through an explicit inbox read.
    let custodianStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      // The steering text reaches the worker framed as a message from the custodian, and that
      // framing also carries the inbox marker. The receiver is recognised by the frame, so it
      // answers instead of reading the inbox again.
      if (serialized.includes('Message from the OpenButler custodian session')) return textStream('Worker acknowledges.');
      if (serialized.includes('owner message via Telegram')) {
        custodianStep += 1;
        if (custodianStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'steer-1',
                toolName: 'session_message',
                input: JSON.stringify({ session: workerId, text: 'Wrap up soon.' }),
              },
            ],
            'tool-calls',
          );
        return textStream('Steered the worker.');
      }
      if (serialized.includes('inbox notification'))
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'read-1',
              toolName: 'inbox',
              input: JSON.stringify({ action: 'read', ids: [await firstInboxId(CUSTODIAN_SESSION_ID, 'Telegram')] }),
            },
          ],

          'tool-calls',
        );
      return textStream('Fixture response');
    });

    await host.receiveTelegramMessage(21, 'Steer the worker from Telegram.');
    await vi.waitFor(() =>
      expect(
        worker.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('Wrap up soon.')),
      ).toBe(true),
    );
    const delivered = worker
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'user' && String(entry.text).includes('Wrap up soon.'));
    expect(delivered?.kind === 'user' ? delivered.text : '').toContain('custodian session');
    expect(delivered?.kind === 'user' ? delivered.text : '').toContain('not from the user');
    await vi.waitFor(() =>
      expect(
        worker.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'Worker acknowledges.'),
      ).toBe(true),
    );
    // The custodian ran the call, not a chat.
    const custodianEntries = loadSavedSession(CUSTODIAN_SESSION_ID)?.entries ?? [];
    expect(custodianEntries.some((entry) => entry.kind === 'assistant' && entry.text === 'Steered the worker.')).toBe(true);

    // The same call cannot be made from an ordinary chat: the tool is not in its
    // toolkit at all, so the model is never offered it.
    const chatTools: string[][] = [];
    model.doStream = vi.fn(async (options: { tools?: unknown }) => {
      chatTools.push(offeredToolNames(options));
      return textStream('Fixture response');
    });
    await viewer.sendMessage({ text: 'Attempt to steer the worker from a chat.', images: [] });
    await vi.waitFor(() => expect(chatTools.length).toBeGreaterThan(0));
    expect(chatTools[0]).not.toContain('session_message');
    expect(chatTools[0]).toContain('custodian_message');
    expect(chatTools[0]).toContain('worker_message');
  }, 15_000);

  it('runs a foreground subagent with a mode-restricted tool set and returns its report', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await newChat();
    const workerNames: string[] = [];
    const parentNames: string[] = [];
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      const names = offeredToolNames(options);
      if (serialized.includes('You are a worker:')) {
        workerNames.push(...names);
        return textStream('WORKER-REPORT: inspected README.');
      }
      parentNames.push(...names);
      if (serialized.includes('WORKER-REPORT')) return textStream('PARENT-SUMMARY: the worker reported back.');
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'subagent-1',
              toolName: 'subagent',
              input: JSON.stringify({
                task: 'PARENT-TASK: inspect README',
                mode: 'explorer',
                background: false,
                context: { paths: ['README.md'] },
              }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-WAITING');
    });

    await viewer.sendMessage({ text: 'Delegate the README inspection.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY: the worker reported back.'),
      ).toBe(true),
    );

    expect(parentNames).toContain('subagent');
    expect(parentNames).toContain('file_read');
    expect(workerNames).toContain('file_read');
    expect(workerNames).not.toContain('file_write');
    expect(workerNames).not.toContain('execute_command');
    expect(workerNames).not.toContain('subagent');
    expect(workerNames).not.toContain('parent_message');
    const toolResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    expect(toolResult?.kind === 'tool' ? toolEntryCommand(toolResult) : '').toMatch(/^subagent explorer/);
  }, 15_000);

  it('delegates an unattended approval to the custodian and runs the action on its decision', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }));
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Approval-gated fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      execute,
    });
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const { ActivityLedger } = await import('../src/activity-ledger.js');
    model.doStream = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream([{ type: 'tool-call', toolCallId: 'task-inspect', toolName: 'inspect', input: '{}' }], 'tool-calls'),
      )
      .mockImplementation(async () => textStream('Delegated task finished'));
    const task = {
      id: 'delegated',
      name: 'Delegated task',
      enabled: true,
      workspaceRoot: root,
      instruction: 'Inspect once when requested.',
      trigger: { adapter: 'manual', options: {} },
    };
    await requestHost('schedule.manage', { input: { action: 'add', schedule: task }, workspaceRoot: root });
    await requestHost('schedule.manage', { input: { action: 'run', scheduleId: task.id }, workspaceRoot: root });

    // The request does not ring the owner's phone: it becomes a durable custodian
    // inbox record naming the request id. Without the delegation this record does
    // not exist at all, so this assertion fails on the previous behaviour.
    const inboxFor = async () => {
      const id = await firstInboxId(CUSTODIAN_SESSION_ID, 'Agent');
      const built = await registry.createModelTools({ sessionId: CUSTODIAN_SESSION_ID, approve: async () => true, onResult: () => {} });
      return (await built.tools.inbox!.execute!({ action: 'read', ids: [id] }, { toolCallId: 'read-agent', messages: [] })) as {
        items?: Array<{ content: { text: string } }>;
      };
    };
    // Reading marks the record read, so the text is captured from the first read.
    let notice = '';
    await vi.waitFor(
      async () => {
        notice = (await inboxFor()).items?.[0]?.content.text ?? '';
        expect(notice).toContain('Approval needed for inspect');
      },
      { timeout: 8000 },
    );
    const requestId = /Request id: ([A-Za-z0-9_-]+)/.exec(notice)?.[1];
    expect(requestId).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();

    // Executed with the custodian's own session id, exactly as its runtime would.
    const decided = await fixtureApprovalDecide!.execute!({ requestId, decision: 'allow' }, undefined, {
      sessionId: CUSTODIAN_SESSION_ID,
    });
    expect(decided).toMatchObject({ status: 'decided', decision: 'allow' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 8000 });

    // The decision is recorded with its author: the custodian decided, not the owner.
    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      const decision = JSON.parse(reader.getState(`approval:decision:${String(requestId)}`) ?? '{}') as { by?: string; decision?: string };
      expect(decision).toMatchObject({ by: 'custodian', decision: 'allow' });
    } finally {
      reader.close();
    }
  }, 20_000);

  it('delivers a chat report to the custodian inbox and to no other session', async () => {
    const settings = await import('../src/settings.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const reporter = await newChat();
    const bystander = await newChat();
    let reporterStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      // The head's turn carries the notice; the report's own title would otherwise
      // match the reporter branch below, because the head is told who is waiting.
      if (prompt.includes('Use inbox to read')) return textStream('CUSTODIAN-SAW-IT');
      if (prompt.includes('AGENT-REPORT-TASK')) {
        reporterStep += 1;
        if (reporterStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'report-1',
                toolName: 'custodian_message',
                input: JSON.stringify({ text: 'The refactor is finished; tests pass.', kind: 'result' }),
              },
            ],
            'tool-calls',
          );
        return textStream('Reported.');
      }
      if (prompt.includes('Agent') && prompt.includes('notification')) return textStream('CUSTODIAN-SAW-IT');
      return textStream('Fixture response');
    });

    await reporter.sendMessage({ text: 'AGENT-REPORT-TASK', images: [] });
    // The custodian is woken by the record, not by the text: the turn carries a count.
    await vi.waitFor(() =>
      expect(
        loadSavedSession(CUSTODIAN_SESSION_ID)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CUSTODIAN-SAW-IT'),
      ).toBe(true),
    );

    const inboxFor = async (sessionId: string) => {
      const built = await registry.createModelTools({ sessionId, approve: async () => true, onResult: () => {} });
      const listed = (await built.tools.inbox!.execute!(
        { action: 'list', source: 'Agent' },
        { toolCallId: 'list-agent', messages: [] },
      )) as {
        items?: Array<{ id: string }>;
      };
      const id = listed.items?.[0]?.id;
      if (!id) return { items: [] };
      return (await built.tools.inbox!.execute!({ action: 'read', ids: [id] }, { toolCallId: 'read-agent', messages: [] })) as {
        items?: Array<{ content: { text: string; note: string; from: string } }>;
      };
    };
    const custodianRead = await inboxFor(CUSTODIAN_SESSION_ID);
    expect(custodianRead.items?.[0]?.content.text).toContain('The refactor is finished; tests pass.');
    // Framing travels with the content: another agent's words are a claim, not an order.
    expect(custodianRead.items?.[0]?.content.note).toContain('not from the user');
    expect(custodianRead.items?.[0]?.content.from).toBe(reporter.getSnapshot().session.id.slice(0, 8));
    // A different session is not the addressee and sees nothing.
    const bystanderRead = await inboxFor(bystander.getSnapshot().session.id);
    expect(bystanderRead.items ?? []).toEqual([]);
  }, 20_000);

  it('does not start another turn for a report the head already saw', async () => {
    const settings = await import('../src/settings.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    settings.saveSettings(settings.defaultSettings());
    const reporter = await newChat();
    let reporterStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      if (prompt.includes('NAG-TASK')) {
        reporterStep += 1;
        if (reporterStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'nag-1',
                toolName: 'custodian_message',
                input: JSON.stringify({ text: 'Halfway through the refactor.', kind: 'progress' }),
              },
            ],
            'tool-calls',
          );
        return textStream('NAG-REPORTED');
      }
      return textStream('Head answers without opening the inbox.');
    });
    const wakeCount = async () =>
      ((await requestHost('ledger.events')) as Array<{ kind: string; payload: { toSessionId?: string } }>).filter(
        (event) => event.kind === 'inbox.wakeup' && event.payload.toSessionId === CUSTODIAN_SESSION_ID,
      ).length;

    await reporter.sendMessage({ text: 'NAG-TASK', images: [] });
    await vi.waitFor(async () => expect(await wakeCount()).toBe(1), { timeout: 8000 });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 300));
    // The head was shown the line and chose not to act: that is a decision, not a missed
    // report, so nothing starts another turn behind its back.
    expect(await wakeCount()).toBe(1);
  }, 20_000);

  it("defers a report turn that arrives inside the owner's gap", async () => {
    registry = new FixtureRegistry();
    await replaceFixtureHost();
    const settings = await import('../src/settings.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    settings.saveSettings({ ...settings.defaultSettings(), custodian: { reportTurnGapSeconds: 2 } });
    const first = await newChat();
    const second = await newChat();
    const steps = new Map<string, number>();
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      const task = prompt.includes('GAP-A') ? 'GAP-A' : prompt.includes('GAP-B') ? 'GAP-B' : null;
      if (task) {
        const step = (steps.get(task) ?? 0) + 1;
        steps.set(task, step);
        if (step === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: `${task}-1`,
                toolName: 'custodian_message',
                input: JSON.stringify({ text: `${task} finished a step.`, kind: 'progress' }),
              },
            ],
            'tool-calls',
          );
        return textStream(`${task}-REPORTED`);
      }
      return textStream('Head answers without opening the inbox.');
    });
    const wakeCount = async () =>
      ((await requestHost('ledger.events')) as Array<{ kind: string; payload: { toSessionId?: string } }>).filter(
        (event) => event.kind === 'inbox.wakeup' && event.payload.toSessionId === CUSTODIAN_SESSION_ID,
      ).length;

    await first.sendMessage({ text: 'GAP-A', images: [] });
    await vi.waitFor(async () => expect(await wakeCount()).toBe(1), { timeout: 8000 });
    await second.sendMessage({ text: 'GAP-B', images: [] });
    // The second report arrives inside the gap: its turn is deferred, not dropped.
    expect(await wakeCount()).toBe(1);
    await vi.waitFor(async () => expect(await wakeCount()).toBe(2), { timeout: 8000 });
  }, 20_000);

  it('switches the report line off without touching delivery', async () => {
    const settings = await import('../src/settings.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_LINE_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    // No gap: this test is about the line, not about how often a turn may start.
    store.custodian = { reportLine: false, reportTurnGapSeconds: 0 };
    settings.saveSettings(store);
    const reporter = await newChat();
    const steps = new Map<string, number>();
    const streamMock = vi.fn(async (options: { prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      // The newest task decides: the transcript already holds the earlier one, so
      // testing LINE-ONE first would replay the first report for the second message.
      const task = prompt.includes('LINE-TWO') ? 'LINE-TWO' : prompt.includes('LINE-ONE') ? 'LINE-ONE' : null;
      if (task) {
        const step = (steps.get(task) ?? 0) + 1;
        steps.set(task, step);
        if (step === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: `${task}-call`,
                toolName: 'custodian_message',
                input: JSON.stringify({ text: `${task} finished.`, kind: 'result' }),
              },
            ],
            'tool-calls',
          );
        return textStream(`${task}-REPORTED`);
      }
      if (prompt.includes('Use inbox to read')) {
        // A two-step head turn: the step boundary is where a line can appear. Each
        // wake is its own turn, so the counter is keyed by the notice that opened it;
        // a shared counter makes every later turn single-step, with no boundary.
        const turn = String((prompt.match(/You have /g) ?? []).length);
        const step = (steps.get(`HEAD-${turn}`) ?? 0) + 1;
        steps.set(`HEAD-${turn}`, step);
        if (step === 1)
          return stream(
            [{ type: 'tool-call', toolCallId: 'head-list', toolName: 'inbox', input: JSON.stringify({ action: 'list', source: 'Agent' }) }],
            'tool-calls',
          );
        return textStream('HEAD-DONE');
      }
      return textStream('Head answers.');
    });
    model.doStream = streamMock;
    const prompts = () => (streamMock.mock.calls as Array<[{ prompt?: unknown }]>).map(([given]) => JSON.stringify(given.prompt ?? []));
    const headPrompts = () => prompts().filter((prompt) => prompt.includes('Use inbox to read'));

    // The chat runs a turn first, so the head has something to address. Its record is
    // debounced, so addressing it immediately is also the case that must not depend on
    // that timer: the head writes the live record before resolving the id.
    await reporter.sendMessage({ text: 'LINE-SETUP', images: [] });
    await host.receiveTelegramMessage(41, 'line probe');
    await vi.waitFor(() => expect(headPrompts().length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    // The head addresses the chat first: only then is its report anchored to a call.
    expect(
      await fixtureSessionMessageTool!.execute!(
        { session: reporter.getSnapshot().session.id, text: 'Report when you are done.' },
        undefined,
        { sessionId: CUSTODIAN_SESSION_ID },
      ),
    ).toMatchObject({ status: 'delivered' });
    await reporter.sendMessage({ text: 'LINE-ONE', images: [] });
    await vi.waitFor(() => expect(headPrompts().length).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    // Switched off: the head is woken and the record is there, but no line is projected.
    expect(headPrompts().every((prompt) => !prompt.includes('waiting from below'))).toBe(true);
    const built = await registry.createModelTools({ sessionId: CUSTODIAN_SESSION_ID, approve: async () => true, onResult: () => {} });
    const listed = (await built.tools.inbox!.execute!({ action: 'list', source: 'Agent' }, { toolCallId: 'line-list', messages: [] })) as {
      items?: unknown[];
    };
    expect(listed.items).toHaveLength(1);

    settings.saveSettings({ ...settings.loadSettings(), custodian: { reportLine: true, reportTurnGapSeconds: 0 } });
    await reporter.sendMessage({ text: 'LINE-TWO', images: [] });
    await vi.waitFor(() => expect(headPrompts().some((prompt) => prompt.includes('waiting from below'))).toBe(true), { timeout: 8000 });
  }, 20_000);

  it('reads the head budget from the owner setting and never writes it on a record', async () => {
    const settings = await import('../src/settings.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_BUDGET_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    store.custodian = { contextLimitTokens: 96_000 };
    settings.saveSettings(store);
    await newChat();
    await host.receiveTelegramMessage(31, 'budget probe');
    type RuntimeOptions = {
      ownerMessageSend?: unknown;
      custodianMessage?: unknown;
      custodianContextLimitTokens?: () => number | undefined;
    };
    await vi.waitFor(() =>
      expect(daemonStart.runtimeOptions.mock.calls.some(([given]) => (given as RuntimeOptions | undefined)?.ownerMessageSend)).toBe(true),
    );
    const calls = daemonStart.runtimeOptions.mock.calls.map(([given]) => given as RuntimeOptions | undefined);
    // The head runs on the configured budget; a chat never inherits it.
    expect(calls.filter((options) => options?.ownerMessageSend).map((options) => options?.custodianContextLimitTokens?.())).toEqual([
      96_000,
    ]);
    expect(
      calls.filter((options) => options?.custodianMessage).every((options) => options?.custodianContextLimitTokens === undefined),
    ).toBe(true);
    await vi.waitFor(() => expect(loadSavedSession(CUSTODIAN_SESSION_ID)).not.toBeNull());
    // The limit is a decision made when it is read, not a field on the conversation.
    expect(JSON.stringify(loadSavedSession(CUSTODIAN_SESSION_ID))).not.toContain('contextLimitTokens');
  }, 20_000);

  it('gives the team surface to the head alone, so a chat holds none of it', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TEAM_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    await newChat();
    await host.receiveTelegramMessage(19, 'team surface probe');
    type TeamRuntimeOptions = Record<string, unknown> & { ownerMessageSend?: unknown; custodianMessage?: unknown };
    const calls = () => daemonStart.runtimeOptions.mock.calls.map(([given]) => given as TeamRuntimeOptions | undefined);
    await vi.waitFor(() => expect(calls().some((options) => options?.ownerMessageSend)).toBe(true));
    // A peer is another machine's head, so the team surface is this machine's voice: a
    // chat that held it could promise something the machine would not stand behind, and
    // the peer could not tell which layer had spoken.
    const teamOptions = [
      'teamDelivery',
      'teamSend',
      'teamGroup',
      'teamHistory',
      'teamStatus',
      'teamSendFile',
      'teamReceiveFile',
      'teamFiles',
      'teamProfile',
      'teamWork',
    ];
    const heads = calls().filter((options) => options?.ownerMessageSend);
    const chats = calls().filter((options) => options?.custodianMessage);
    expect(chats.length).toBeGreaterThan(0);
    expect(heads.map((options) => teamOptions.filter((name) => options?.[name] !== undefined))).toEqual([teamOptions]);
    expect(chats.every((options) => teamOptions.every((name) => options?.[name] === undefined))).toBe(true);
  }, 20_000);

  it('runs the head on the model the owner pinned and leaves a chat on its own', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_PIN_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    store.custodian = { provider: 'fixture', model: 'pinned-head' };
    settings.saveSettings(store);
    const chat = await newChat();
    await chat.sendMessage({ text: 'PIN-CHAT', images: [] });
    // A chat is a different layer: the head's pin never reaches it.
    expect(fixtureSelectModels).toEqual([]);
    await host.receiveTelegramMessage(53, 'model pin probe');
    // The head's model is a machine setting, applied at the boundary of its next turn.
    await vi.waitFor(() => expect(fixtureSelectModels).toEqual([{ providerId: 'fixture', modelId: 'pinned-head' }]));
  }, 20_000);

  it('lets the head start a durable chat whose first turn is the instruction, and the owner can open it', async () => {
    const settings = await import('../src/settings.js');
    const { listSavedSessions, loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const store = settings.defaultSettings();
    store.defaultWorkspaceRoot = root;
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    // A control chat: it resolves the same default scope through the ordinary path,
    // so a created session that invented a folder of its own cannot pass.
    const control = await newChat();
    const known = new Set(listSavedSessions().map((session) => session.id));
    let custodianStep = 0;
    model.doStream = vi
      .fn()
      // The owner's Telegram text reaches the head only through an inbox read.
      .mockImplementationOnce(async () =>
        stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'read-1',
              toolName: 'inbox',
              input: JSON.stringify({ action: 'read', ids: [await firstInboxId(CUSTODIAN_SESSION_ID, 'Telegram')] }),
            },
          ],
          'tool-calls',
        ),
      )
      .mockImplementation(async (options: { prompt?: unknown }) => {
        const prompt = JSON.stringify(options.prompt ?? []);
        if (prompt.includes('START-A-CHAT')) {
          custodianStep += 1;
          if (custodianStep === 1)
            return stream(
              [
                {
                  type: 'tool-call',
                  toolCallId: 'new-1',
                  toolName: 'session_new',
                  input: JSON.stringify({ instruction: 'MAP-THE-REPOSITORY' }),
                },
              ],
              'tool-calls',
            );
          return textStream('CREATED-A-CHAT');
        }
        if (prompt.includes('MAP-THE-REPOSITORY')) return textStream('CHAT-FIRST-TURN');
        return textStream('Fixture response');
      });

    await host.receiveTelegramMessage(71, 'START-A-CHAT');

    const created = () => listSavedSessions().filter((session) => !known.has(session.id) && session.id !== CUSTODIAN_SESSION_ID);
    await vi.waitFor(() => expect(created().length).toBe(1), { timeout: 20_000 });
    const target = created()[0]!;

    await vi.waitFor(
      () => {
        const saved = loadSavedSession(target.id);
        expect(saved?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CHAT-FIRST-TURN')).toBe(true);
      },
      { timeout: 20_000 },
    );

    const saved = loadSavedSession(target.id)!;
    const first = saved.entries.find((entry) => entry.kind === 'user')!;
    // The instruction is the head's word, framed so the chat cannot read it as the owner's.
    expect(first.text).toContain('MAP-THE-REPOSITORY');
    expect(first.text).toContain('not from the user');
    // Scope: the folder the head was working in, not one it picked for the child.
    const opened = await openChat(target.id);
    expect(opened.runtime.workspaceRoot).toBe(control.runtime.workspaceRoot);
    expect(opened.getSnapshot().session.id).toBe(target.id);
  }, 40_000);

  it('offers session_new to the head and to no chat', async () => {
    const settings = await import('../src/settings.js');
    const store = settings.defaultSettings();
    store.telegram = { enabled: true, tokenEnv: 'FTG_TOKEN', workspaceRoot: root, chatId: '1', userId: '2' };
    settings.saveSettings(store);
    const chatOffered: string[][] = [];
    const custodianOffered: string[][] = [];
    model.doStream = vi.fn(async (options: { tools?: unknown; prompt?: unknown }) => {
      const prompt = JSON.stringify(options.prompt ?? []);
      if (prompt.includes('CHAT-PROBE')) {
        chatOffered.push(offeredToolNames(options));
        return textStream('Chat answer');
      }
      custodianOffered.push(offeredToolNames(options));
      return textStream('Custodian answer');
    });

    const chat = await newChat();
    await chat.sendMessage({ text: 'CHAT-PROBE', images: [] });
    await vi.waitFor(() => expect(chatOffered.length).toBeGreaterThan(0));
    await host.receiveTelegramMessage(72, 'Head probe');
    await vi.waitFor(() => expect(custodianOffered.length).toBeGreaterThan(0));

    // Creation is the head's verb alone: the name never reaches a chat, so a chat
    // cannot spend a call learning that it may not open sessions.
    expect(custodianOffered[0]).toContain('session_new');
    expect(chatOffered[0]).not.toContain('session_new');
    expect(chatOffered[0]).toContain('inbox');
  }, 20_000);

  it('gives a worker its parent channel and no way to reach the custodian or a chat', async () => {
    registerFakeTool('file_read');
    const viewer = await newChat();
    const workerNames: string[] = [];
    const workerPrompts: string[] = [];
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) {
        workerNames.push(...offeredToolNames(options));
        workerPrompts.push(serialized);
        return textStream('WORKER-REPORT: nothing to do.');
      }
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'worker-1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'WORKER-TASK: look around', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-WAITING');
    });

    await viewer.sendMessage({ text: 'Delegate this.', images: [] });
    await vi.waitFor(() => expect(workerNames.length).toBeGreaterThan(0));

    expect(workerNames).toContain('parent_message');
    // Absent, not refused: a worker's mail goes to its parent, so it holds neither
    // the head's channel nor a way to name a chat.
    expect(workerNames).not.toContain('custodian_message');
    expect(workerNames).not.toContain('session_message');
    // It may start one child layer, so it may steer that child and nothing else:
    // worker_message is present, and the host still refuses any worker it did not spawn.
    expect(workerNames).toContain('worker_message');
    // A worker's base is its own text: it never reads the agent policy first and
    // then a contradicting role note.
    expect(workerPrompts[0]).toContain('You are a worker: a bounded execution context');
    expect(workerPrompts[0]).not.toContain('## Where you sit');
    expect(workerPrompts[0]).toContain('Every tool result is stamped');
  }, 20_000);

  it('lets an executor subagent start one child layer but not a third layer', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await newChat();
    const childNames: string[] = [];
    const grandchildNames: string[] = [];
    let childStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      const names = offeredToolNames(options);
      if (serialized.includes('You are a worker:')) {
        if (serialized.includes('CHILD-TASK')) {
          childStep += 1;
          if (childStep === 1) {
            childNames.push(...names);
            return stream(
              [
                {
                  type: 'tool-call',
                  toolCallId: 'subagent-2',
                  toolName: 'subagent',
                  input: JSON.stringify({ task: 'GRAND-TASK: inspect deeper', mode: 'executor', background: false }),
                },
              ],
              'tool-calls',
            );
          }
          return textStream('CHILD-REPORT: child finished.');
        }
        grandchildNames.push(...names);
        return textStream('GRAND-REPORT: deeper inspection done.');
      }
      if (serialized.includes('CHILD-REPORT')) return textStream('PARENT-SUMMARY-NESTED: nested worker finished.');
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: 'subagent-parent',
            toolName: 'subagent',
            input: JSON.stringify({ task: 'CHILD-TASK: delegate deeper', mode: 'executor', background: false }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Delegate the deep inspection.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY-NESTED: nested worker finished.'),
      ).toBe(true),
    );

    expect(childNames).toContain('subagent');
    expect(childNames).toContain('file_write');
    expect(grandchildNames).toContain('file_read');
    expect(grandchildNames).toContain('file_write');
    expect(grandchildNames).not.toContain('subagent');
    const toolResult = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('CHILD-REPORT'));
    expect(toolResult).toBeDefined();
  }, 15_000);

  it('opens a subagent session view-only and refuses messages to it', async () => {
    const viewer = await newChat();
    const mainId = viewer.getSnapshot().session.id;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) {
        await workerGate;
        return textStream('WORKER-REPORT: view test done.');
      }
      if (serialized.includes('WORKER-REPORT')) return textStream('PARENT-SUMMARY: view test done.');
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'subagent-view',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'VIEW-TASK: wait for the gate', mode: 'explorer', background: false }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-WAITING');
    });

    const parentRun = viewer.sendMessage({ text: 'Delegate the view test.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.running === true)).toBe(true),
    );

    const live = await client({ runningWorkerOf: mainId });
    expect(live.getSnapshot().session.id).not.toBe(mainId);
    expect(live.getSnapshot().busy).toBe(true);
    expect(live.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && String(entry.text).includes('VIEW-TASK'))).toBe(
      true,
    );
    await live.sendMessage({ text: 'Are you done?', images: [] });
    expect(live.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('view-only'))).toBe(true);

    releaseWorker();
    await parentRun;
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SUMMARY: view test done.'),
      ).toBe(true),
    );

    const toolEntry = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    const workerId = toolEntry?.kind === 'tool' ? toolEntry.session : undefined;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);
    const completed = await client({ workerSessionId: workerId! });
    expect(completed.getSnapshot().session.id).toBe(workerId);
    expect(
      completed.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('WORKER-REPORT')),
    ).toBe(true);
  }, 20_000);

  it('opens a settled worker read-only from the saved transcript after a host restart', async () => {
    const viewer = await newChat();
    let parentStep = 0;
    model.doStream = vi.fn(async (options: { prompt?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) return textStream('WORKER-REPORT: restart view test done.');
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'subagent-restart',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'RESTART-TASK: settle quickly', mode: 'explorer', background: false }),
            },
          ],
          'tool-calls',
        );
      return textStream('PARENT-AFTER-RESTART-CHECK');
    });

    await viewer.sendMessage({ text: 'Delegate the restart view test.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'))).toBe(
        true,
      ),
    );
    const toolEntry = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    const workerId = toolEntry?.kind === 'tool' ? toolEntry.session : undefined;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);

    // The restarted host holds no live worker sessions: only the saved record and the ledger remain.
    await replaceFixtureHost();

    const view = await client({ workerSessionId: workerId! });
    expect(view.getSnapshot().session.id).toBe(workerId);
    expect(view.getSnapshot().busy).toBe(false);
    expect(view.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('WORKER-REPORT'))).toBe(
      true,
    );
    await view.sendMessage({ text: 'Are you done?', images: [] });
    expect(view.getSnapshot().session.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('view-only'))).toBe(true);

    // An id with no producer on this machine still refuses instead of opening a chat-shaped view.
    await expect(client({ workerSessionId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('not a subagent worker');
  }, 20_000);

  it('runs a background subagent and automatically wakes its idle parent for the final report', async () => {
    registerFakeTool('file_read');
    registerFakeTool('file_write');
    registerFakeTool('execute_command');
    const viewer = await newChat();
    const workerNames: string[] = [];
    let parentStep = 0;
    let workerStep = 0;
    let sawNote = false;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) {
        if (workerStep === 0) {
          workerStep += 1;
          workerNames.push(...offeredToolNames(options));
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'pm-1',
                toolName: 'parent_message',
                input: JSON.stringify({ text: 'PROGRESS-NOTE: halfway there.' }),
              },
            ],
            'tool-calls',
          );
        }
        await workerGate;
        return textStream('WORKER-REPORT: background done.');
      }
      if (/\\?"report\\?":\\?"WORKER-REPORT/.test(serialized)) return textStream('PARENT-DONE: read the final report.');
      if (!sawNote && serialized.includes('PROGRESS-NOTE')) {
        sawNote = true;
        return textStream('PARENT-SAW-NOTE: got it, will check the report later.');
      }
      parentStep += 1;
      if (parentStep === 1) {
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'BG-TASK: work in the background', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      }
      if (parentStep > 40) {
        return textStream('PARENT-GAVE-UP: poll loop did not converge.');
      }
      // The parent polls the way the tool now requires: list, then open one
      // notification by the short code it was given.

      // The parent polls the way the tool now works: list first, then open one
      // notification by the short code the list returned.
      const listed = /"id":"([0-9A-HJKMNP-TV-Z]{6})"/.exec(serialized);
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `poll-${parentStep}`,
            toolName: 'inbox',
            input: listed ? JSON.stringify({ action: 'read', ids: [listed[1]] }) : JSON.stringify({ action: 'list', source: 'Subagent' }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Delegate in background.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some(
            (entry) => entry.kind === 'assistant' && entry.text === 'PARENT-SAW-NOTE: got it, will check the report later.',
          ),
      ).toBe(true),
    );

    const spawnResult = viewer
      .getSnapshot()
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
    expect(spawnResult).toBeDefined();
    expect(workerNames).toContain('parent_message');
    expect(workerNames).toContain('file_write');
    expect(workerNames).toContain('subagent');
    const notePoll = viewer.getSnapshot().session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('PROGRESS-NOTE'));
    expect(notePoll).toBeDefined();
    const noteResult = notePoll?.kind === 'tool' ? notePoll.result : '';
    expect(noteResult).toContain('Running');
    expect(noteResult).toContain('1 call');
    expect(noteResult).toContain('parent_message');

    releaseWorker();
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-DONE: read the final report.'),
      ).toBe(true),
    );
    const reportPoll = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('WORKER-REPORT'));
    expect(reportPoll).toBeDefined();
    expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(true);
    // Once the parent has consumed the report, the completion must settle: a raw
    // signal check used to ignore the staged read and requeue a fresh empty wake
    // on every pump (815 claims observed on one event).
    await vi.waitFor(async () => {
      const events = (await requestHost('ledger.events')) as { kind: string; status: string }[];
      const completions = events.filter((entry) => entry.kind === 'worker.completed');
      expect(completions.length).toBeGreaterThan(0);
      expect(completions[completions.length - 1]!.status).toBe('delivered');
    });
    // Queued wakes carry a visible message; empty rows must never reach the queue.
    expect(viewer.getSnapshot().queuedMessages.every((message) => message.text.trim().length > 0)).toBe(true);
  }, 20_000);

  it('lets only the parent stop its background worker', async () => {
    registerFakeTool('file_read');
    const viewer = await newChat();
    let parentStep = 0;
    let isolatedStep = 0;
    let checkStep = 0;
    let capturedWorkerId = '';
    const abortableWorkerStream = (signal?: AbortSignal | null) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'work' });
          controller.enqueue({ type: 'text-delta', id: 'work', delta: 'Working…' });
          const finish = () => {
            try {
              controller.enqueue({ type: 'text-end', id: 'work' });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
              controller.close();
            } catch {
              /* already closed */
            }
          };
          if (signal?.aborted) finish();
          else signal?.addEventListener('abort', finish, { once: true });
        },
      }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; tools?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) {
        return abortableWorkerStream(options.abortSignal ?? null);
      }
      if (serialized.includes('ISOLATED-PROBE')) {
        isolatedStep += 1;
        if (isolatedStep === 1)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'stop-x',
                toolName: 'subagent_stop',
                input: JSON.stringify({ session: capturedWorkerId }),
              },
            ],
            'tool-calls',
          );
        return textStream('ISOLATED-DONE');
      }
      if (/\\?"status\\?":\\?"finished"/.test(serialized)) return textStream('PARENT-DONE: worker halted.');
      if (serialized.includes('Check it.')) {
        // Same flow the tool now requires: list to get the short code, then open it by that code.
        const listed = /"id":"([0-9A-HJKMNP-TV-Z]{6})"/.exec(serialized);
        checkStep += 1;
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: `check-${checkStep}`,
              toolName: 'inbox',
              input: JSON.stringify(listed ? { action: 'read', ids: [listed[1]] } : { action: 'list', source: 'Subagent' }),
            },
          ],
          'tool-calls',
        );
      }
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'bg-stop-1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'BG-STOP-TASK: wait to be stopped', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 2) {
        capturedWorkerId = workerIdFrom(serialized);
        // Nothing has been sent by the worker yet, so there is nothing to open;
        // list keeps the flow honest instead of opening by a raw reference.
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'poll-stop-1',
              toolName: 'inbox',
              input: JSON.stringify({ action: 'list', source: 'Subagent' }),
            },
          ],
          'tool-calls',
        );
      }
      if (parentStep === 3)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'stop-1',
              toolName: 'subagent_stop',
              input: JSON.stringify({ session: capturedWorkerId }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 4) return textStream('PARENT-STOPPED: stop call sent.');
      if (parentStep > 8) return textStream('PARENT-GAVE-UP: stop loop did not converge.');
      const listed = /"id":"([0-9A-HJKMNP-TV-Z]{6})"/.exec(serialized);
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `poll-stop-${parentStep}`,
            toolName: 'inbox',
            input: JSON.stringify(listed ? { action: 'read', ids: [listed[1]] } : { action: 'list', source: 'Subagent' }),
          },
        ],
        'tool-calls',
      );
    });

    await viewer.sendMessage({ text: 'Stop the worker test.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewer
          .getSnapshot()
          .session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-STOPPED: stop call sent.'),
      ).toBe(true),
    );
    const spawnResult = viewer
      .getSnapshot()
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
    expect(spawnResult).toBeDefined();
    const stopResult = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('Stop '));
    expect(stopResult).toBeDefined();
    const spawnedWorkerId = spawnResult?.kind === 'tool' ? spawnResult.session : undefined;
    expect(spawnedWorkerId).toMatch(/^[0-9a-f-]{36}$/);

    const workerView = await client({ workerSessionId: spawnedWorkerId! });
    expect(workerView.getSnapshot().session.id).toBe(spawnedWorkerId);
    await vi.waitFor(() => expect(workerView.getSnapshot().busy).toBe(false), { timeout: 10_000 });

    await viewer.sendMessage({ text: 'Check it.', images: [] });
    await vi.waitFor(() =>
      expect(
        viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT-DONE: worker halted.'),
      ).toBe(true),
    );
    const finalPoll = viewer
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.session === capturedWorkerId && entry.result.includes('Finished'));
    expect(finalPoll).toBeDefined();
    expect(finalPoll?.kind === 'tool' ? finalPoll.result : '').toContain('Run cancelled.');
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'WORKER-SHOULD-NOT-ARRIVE'),
    ).toBe(false);

    const isolated = await client({ isolatedSession: true });
    await isolated.sendMessage({ text: 'ISOLATED-PROBE stop please.', images: [] });
    await vi.waitFor(() =>
      expect(
        isolated.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result.includes('Only the parent')),
      ).toBe(true),
    );
    const denied = isolated
      .getSnapshot()
      .session.entries.find((entry) => entry.kind === 'tool' && entry.result.includes('Only the parent'));
    expect(denied?.kind === 'tool' ? denied.result : '').toContain('may stop it');
  }, 20_000);

  it('caps a parent at eight running workers and frees the slot when one stops', async () => {
    const viewer = await newChat();
    let parentStep = 0;
    let retrySpawned = false;
    const spawnCall = (callId: string, task: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent',
      input: JSON.stringify({ task, mode: 'executor', background: true }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:')) return holdOpenWorkerStream(options.abortSignal ?? null);
      if (serialized.includes('Retry after release.')) {
        if (retrySpawned) return textStream('CAP-RETRY-OK');
        retrySpawned = true;
        return stream([spawnCall('cap-m9r', 'CAP-M9R: the retried worker')], 'tool-calls');
      }
      parentStep += 1;
      if (parentStep <= 8) return stream([spawnCall(`cap-m${parentStep}`, `CAP-M${parentStep}: hold until stopped`)], 'tool-calls');
      if (parentStep === 9) return stream([spawnCall('cap-m9', 'CAP-M9: over the cap')], 'tool-calls');
      return textStream('CAP-BUSY-SEEN');
    });

    await viewer.sendMessage({ text: 'Fill the worker cap.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CAP-BUSY-SEEN')).toBe(true),
    );
    const toolEntries = viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'tool');
    const started = toolEntries
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(started).toHaveLength(8);
    const busy = toolEntries.find(
      (entry) => entry.kind === 'tool' && entry.session === undefined && toolEntryCommand(entry).startsWith('subagent '),
    );
    expect(busy?.kind === 'tool' ? busy.result : '').toContain('limit 8');
    const workerIds = started;

    const firstView = await client({ workerSessionId: workerIds[0]! });
    firstView.stop();
    await vi.waitFor(() => expect(firstView.getSnapshot().busy).toBe(false), { timeout: 10_000 });

    await viewer.sendMessage({ text: 'Retry after release.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CAP-RETRY-OK')).toBe(true),
    );
    const startedAfter = viewer
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'tool')
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(startedAfter).toHaveLength(9);
    const retriedId = startedAfter[8]!;

    for (const workerId of [...workerIds.slice(1), retriedId]) {
      const view = await client({ workerSessionId: workerId });
      view.stop();
      await vi.waitFor(() => expect(view.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    }
  }, 30_000);

  it('caps a worker parent at two children and lets the worker stop them', async () => {
    const viewer = await newChat();
    let parentStep = 0;
    let workerStep = 0;
    const uuidsIn = (serialized: string): string[] =>
      [...serialized.matchAll(/\\?"session\\?":\\?"([0-9a-f-]{36})\\?"/g)].map((match) => match[1]!);
    const spawnChild = (callId: string, task: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent',
      input: JSON.stringify({ task, mode: 'explorer', background: true }),
    });
    const stopCall = (callId: string, session: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'subagent_stop',
      input: JSON.stringify({ session }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:') && serialized.includes('CHILD-CAP-W')) {
        workerStep += 1;
        const ids = uuidsIn(serialized);
        if (workerStep === 1) return stream([spawnChild('child-1', 'CHILD-C1: wait to be stopped')], 'tool-calls');
        if (workerStep === 2) return stream([spawnChild('child-2', 'CHILD-C2: wait to be stopped')], 'tool-calls');
        if (workerStep === 3) return stream([spawnChild('child-3', 'CHILD-C3: over the cap')], 'tool-calls');
        if (workerStep === 4) return stream([stopCall('stop-c1', ids[0]!)], 'tool-calls');
        if (workerStep === 5) return stream([stopCall('stop-c2', ids[1]!)], 'tool-calls');
        return textStream('WORKER-CAP-DONE');
      }
      if (serialized.includes('You are a worker:')) return holdOpenWorkerStream(options.abortSignal ?? null);
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'cap-w',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'CHILD-CAP-W: manage children', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      return textStream('CHILD-CAP-STARTED');
    });

    await viewer.sendMessage({ text: 'Run the child cap test.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'CHILD-CAP-STARTED')).toBe(
        true,
      ),
    );
    const spawned = viewer
      .getSnapshot()
      .session.entries.find(
        (entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && typeof entry.session === 'string',
      );
    const workerId = spawned?.kind === 'tool' ? spawned.session : undefined;
    expect(workerId).toMatch(/^[0-9a-f-]{36}$/);

    const { loadSavedSession: loadWorkerSession } = await import('../src/session-store.js');
    await vi.waitFor(
      () => {
        const done = loadWorkerSession(workerId!)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'WORKER-CAP-DONE');
        expect(done).toBe(true);
      },
      { timeout: 15_000 },
    );
    const results = (loadWorkerSession(workerId!)?.entries ?? [])
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => String((entry as { result?: unknown }).result ?? ''));
    expect(results.filter((result) => result.includes('Started'))).toHaveLength(2);
    const childBusy = results.find((result) => result.includes('limit 2'));
    expect(childBusy ?? '').toContain('already runs 2 subagents');
    expect(results.filter((result) => result.includes('Stopped'))).toHaveLength(2);
  }, 20_000);

  it('locks a file to the worker that writes it until its run ends', async () => {
    registry.register({
      providerId: 'fixture',
      name: 'file_write',
      description: 'Fixture file write that honours the worker write lease.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      effect: { change: 'modify', data: 'public', network: 'none', reversible: 'full', outbound: 'none' },
      resolveTarget: (input) => resolve(root, String((input as { path?: unknown }).path ?? '')),
      workspaceScope: () => 'workspace',
      execute: async (input: unknown, _signal?: AbortSignal, context?: { guardWrite?: (path: string) => string | null }) => {
        const path = String((input as { path?: unknown }).path ?? '');
        const denied = context?.guardWrite?.(path);
        return denied ? { status: 'denied', error: denied } : { status: 'completed', path };
      },
    });
    const viewer = await newChat();
    let parentStep = 0;
    let w1Step = 0;
    let w2Step = 0;
    let w1Wrote!: () => void;
    const w1WrotePromise = new Promise<void>((resolve) => {
      w1Wrote = resolve;
    });
    let releaseW1!: () => void;
    const w1StoppedPromise = new Promise<void>((resolve) => {
      releaseW1 = resolve;
    });
    const writeCall = (callId: string) => ({
      type: 'tool-call' as const,
      toolCallId: callId,
      toolName: 'fixture__file_write',
      input: JSON.stringify({ path: 'shared.txt', content: 'lease' }),
    });
    model.doStream = vi.fn(async (options: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
      const serialized = JSON.stringify(options.prompt ?? []);
      if (serialized.includes('You are a worker:') && serialized.includes('LEASE-W1')) {
        w1Step += 1;
        if (w1Step === 1) return stream([writeCall('lease-w1-write')], 'tool-calls');
        w1Wrote();
        return holdOpenWorkerStream(options.abortSignal ?? null);
      }
      if (serialized.includes('You are a worker:') && serialized.includes('LEASE-W2')) {
        w2Step += 1;
        if (w2Step === 1) {
          await w1WrotePromise;
          return stream([writeCall('lease-w2-write-1')], 'tool-calls');
        }
        if (w2Step === 2) {
          await w1StoppedPromise;
          return stream([writeCall('lease-w2-write-2')], 'tool-calls');
        }
        return textStream('LEASE-DONE');
      }
      if (serialized.includes('You are a worker:')) return holdOpenWorkerStream(options.abortSignal ?? null);
      parentStep += 1;
      if (parentStep === 1)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'lease-w1',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'LEASE-W1: write first', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      if (parentStep === 2)
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'lease-w2',
              toolName: 'subagent',
              input: JSON.stringify({ task: 'LEASE-W2: write second', mode: 'executor', background: true }),
            },
          ],
          'tool-calls',
        );
      return textStream('LEASE-STARTED');
    });

    await viewer.sendMessage({ text: 'Run the lease test.', images: [] });
    await vi.waitFor(() =>
      expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'LEASE-STARTED')).toBe(true),
    );
    await w1WrotePromise;
    const spawned = viewer
      .getSnapshot()
      .session.entries.filter((entry) => entry.kind === 'tool')
      .map((entry) => (entry.kind === 'tool' ? entry.session : undefined))
      .filter((session): session is string => typeof session === 'string');
    expect(spawned).toHaveLength(2);
    const [w1Id, w2Id] = spawned as [string, string];

    const w1View = await client({ workerSessionId: w1Id });
    w1View.stop();
    await vi.waitFor(() => expect(w1View.getSnapshot().busy).toBe(false), { timeout: 10_000 });
    releaseW1();

    const { loadSavedSession: loadWorkerSession } = await import('../src/session-store.js');
    await vi.waitFor(
      () => {
        const done = loadWorkerSession(w2Id)?.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'LEASE-DONE');
        expect(done).toBe(true);
      },
      { timeout: 15_000 },
    );
    const results = (loadWorkerSession(w2Id)?.entries ?? [])
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => String((entry as { result?: unknown }).result ?? ''));
    const denied = results.find((result) => result.includes('Another running subagent'));
    expect(denied ?? '').toContain('shared.txt');
    expect(results.filter((result) => result.includes('"status": "completed"'))).toHaveLength(1);
  }, 20_000);
});

async function automaticWorkerFixture(options: { fail?: boolean; question?: boolean; longReport?: boolean } = {}) {
  const viewer = await newChat();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let spawned = false;
  let noteSent = false;
  let questionHandled = false;
  let parentCalls = 0;
  const seenCodes: string[] = [];
  model.doStream = vi.fn(async (input: { prompt?: unknown; abortSignal?: AbortSignal | null }) => {
    const serialized = JSON.stringify(input.prompt ?? []);
    if (serialized.includes('You are a worker:')) {
      if (options.question && !noteSent) {
        noteSent = true;
        return stream(
          [
            {
              type: 'tool-call',
              toolCallId: 'important-note',
              toolName: 'parent_message',
              input: JSON.stringify({ text: 'NEED_PARENT_DECISION', kind: 'question' }),
            },
          ],
          'tool-calls',
        );
      }
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) resolve();
          else input.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      if (options.fail) throw new Error('WORKER_FAILURE_FIXTURE');
      // A report longer than the inline limit is the case that used to break
      // the receipt: the tool result was replaced by a preview, the preview
      // held no handover, and the notification could never be closed.
      return textStream(options.longReport ? `AUTOMATIC_WORKER_REPORT${'z'.repeat(40_000)}` : 'AUTOMATIC_WORKER_REPORT');
    }
    parentCalls++;
    if (parentCalls > 20) return textStream(`FIXTURE_STALLED: ${serialized.slice(-1800)}`);
    if (serialized.includes('AUTOMATIC_WORKER_REPORT')) return textStream('PARENT_RESULT_INTEGRATED');
    if (serialized.includes('WORKER_FAILURE_FIXTURE')) return textStream('PARENT_FAILURE_HANDLED');
    if (serialized.includes('NEED_PARENT_DECISION') && !questionHandled) {
      questionHandled = true;
      return textStream('PARENT_QUESTION_HANDLED');
    }
    if (!spawned) {
      spawned = true;
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: 'automatic-child',
            toolName: 'subagent',
            input: JSON.stringify({ task: 'Run a bounded background task.', mode: 'executor', background: true }),
          },
        ],
        'tool-calls',
      );
    }
    if (serialized.includes('[Host context: inbox notification]')) {
      expect(serialized).not.toContain('AUTOMATIC_WORKER_REPORT');
      const listed = /"id":"([0-9A-HJKMNP-TV-Z]{6})"/.exec(serialized);
      if (listed) seenCodes.push(listed[1]);
      return stream(
        [
          {
            type: 'tool-call',
            toolCallId: `read-worker-${parentCalls}`,
            toolName: 'inbox',
            input: JSON.stringify(listed ? { action: 'read', ids: [listed[1]] } : { action: 'list', source: 'Subagent' }),
          },
        ],
        'tool-calls',
      );
    }
    return textStream('PARENT_READY');
  });
  await viewer.sendMessage({ text: 'Delegate and continue independently.', images: [] });
  await vi.waitFor(() =>
    expect(
      viewer
        .getSnapshot()
        .session.entries.some((entry) => entry.kind === 'assistant' && ['PARENT_READY', 'PARENT_QUESTION_HANDLED'].includes(entry.text)),
    ).toBe(true),
  );
  const worker = viewer
    .getSnapshot()
    .session.entries.find((entry) => entry.kind === 'tool' && toolEntryCommand(entry).startsWith('subagent ') && entry.session);
  if (!worker || worker.kind !== 'tool' || !worker.session) throw new Error('Worker id was not returned');
  return { viewer, workerId: worker.session, release, parentCalls: () => parentCalls, seenCodes: () => seenCodes };
}

it('wakes the idle parent when its background worker fails', async () => {
  const { viewer, release } = await automaticWorkerFixture({ fail: true });
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_FAILURE_HANDLED'),
    ).toBe(true),
  );
  expect(viewer.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it('enforces parent and owner boundaries through the single inbox tool', async () => {
  const settings = await import('../src/settings.js');
  const store = settings.defaultSettings();
  store.telegram = { enabled: true, tokenEnv: 'FTG_BOUNDARY_TOKEN', workspaceRoot: root, chatId: '88', userId: '9' };
  settings.saveSettings(store);
  vi.stubEnv('FTG_BOUNDARY_TOKEN', '123456:fixture-boundary-token-value-ok');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      let result: unknown = true;
      if (method === 'getMe') result = { is_bot: true, username: 'boundary_bot' };
      if (method === 'getWebhookInfo') result = {};
      if (method === 'getUpdates')
        result = await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Fixture polling aborted.')), { once: true });
        });
      if (method === 'sendMessage') result = { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }));
    }),
  );
  // The question note is what creates the Subagent notification; the fixture drains it,
  // and the short code it was opened by names a notification the parent's box holds.
  const { workerId, release, seenCodes } = await automaticWorkerFixture({ question: true });
  const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
  const executeAs = async (sessionId: string, input: Record<string, unknown>) => {
    const built = await registry.createModelTools({ sessionId, approve: async () => true, onResult: () => {} });
    return built.tools.inbox!.execute!(input, { toolCallId: 'inbox-boundary', messages: [] });
  };
  try {
    expect(await executeAs('another-parent', { action: 'list', source: 'Subagent' })).toMatchObject({ items: [] });
    const workerCode = seenCodes()[0];
    expect(workerCode).toBeTruthy();
    // A foreign session can hold the code, but the box only answers codes it holds
    // itself: opening is the parent's call alone, and nothing is delivered.
    expect(await executeAs('another-parent', { action: 'read', ids: [workerCode!] })).toMatchObject({
      status: 'invalid',
      unresolved: [workerCode],
    });
    await requestHost('settings.reload');
    await host.receiveTelegramMessage(4242, 'boundary probe');
    // The custodian is the owner channel: a worker's box never holds an owner
    // notification, so a code it was handed does not resolve at all.
    const telegramCode = await firstInboxId(CUSTODIAN_SESSION_ID, 'Telegram');
    expect(await executeAs(workerId, { action: 'read', ids: [telegramCode] })).toMatchObject({
      status: 'invalid',
      unresolved: [telegramCode],
    });
    expect(await executeAs(workerId, { action: 'list', source: 'Team' })).toMatchObject({ items: [] });
  } finally {
    release();
    vi.unstubAllGlobals();
  }
}, 20_000);

it('wakes the parent for a material question while the worker is still running', async () => {
  const { viewer, release } = await automaticWorkerFixture({ question: true });
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_QUESTION_HANDLED'),
    ).toBe(true),
  );
  expect(viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result.includes('NEED_PARENT_DECISION'))).toBe(
    true,
  );
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
}, 20_000);

it('retains a completion across owner pause and host restart, then wakes only its original parent on resume', async () => {
  const { viewer, release, workerId, parentCalls } = await automaticWorkerFixture();
  const parentId = viewer.getSnapshot().session.id;
  viewer.stop({ holdQueue: true });
  await vi.waitFor(() => expect(viewer.getSnapshot().session.automaticWakeHeld).toBe(true));
  const calls = parentCalls();
  release();
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const { readWorkerRecord } = await import('../src/worker-records.js');
  await vi.waitFor(() => {
    const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
    try {
      expect(readWorkerRecord(reader, workerId)?.finished).toBe(true);
      expect(reader.pendingEvents().some((event) => event.source === 'worker')).toBe(true);
    } finally {
      reader.close();
    }
  });
  expect(parentCalls()).toBe(calls);
  await Promise.all(clients.map((entry) => entry.close()));
  clients = [];
  await host.close();
  registry = new FixtureRegistry();
  host = await createFixtureHost();
  await host.start();
  const resumed = await openChat(parentId);
  expect(resumed.getSnapshot().session.id).toBe(parentId);
  expect(resumed.getSnapshot().session.automaticWakeHeld).toBe(true);
  expect(resumed.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.source === 'inbox')).toBe(false);
  await resumed.sendMessage({ text: 'Resume my work.', images: [] });
  await vi.waitFor(() =>
    expect(
      resumed.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
  expect(resumed.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it('reconciles a saved poll after a crash before its ledger receipt without waking the parent twice', async () => {
  const { viewer, release, workerId, parentCalls } = await automaticWorkerFixture();
  const parentId = viewer.getSnapshot().session.id;
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const { readWorkerRecord, writeWorkerRecord } = await import('../src/worker-records.js');
  const writer = new ActivityLedger(join(root, 'state.db'));
  try {
    await vi.waitFor(() => expect(readWorkerRecord(writer, workerId)?.reportedRevision).toBe(1));
    writeWorkerRecord(writer, workerId, { ...readWorkerRecord(writer, workerId)!, reportedRevision: 0 });
    const event = writer.listEvents().find((entry) => entry.source === 'worker' && entry.payload.workerId === workerId)!;
    writer.setEventState(event.id, 'pending');
  } finally {
    writer.close();
  }
  const calls = parentCalls();
  await Promise.all(clients.map((entry) => entry.close()));
  clients = [];
  await host.close();
  registry = new FixtureRegistry();
  host = await createFixtureHost();
  await host.start();
  const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
  try {
    await vi.waitFor(() => expect(readWorkerRecord(reader, workerId)?.reportedRevision).toBe(1));
  } finally {
    reader.close();
  }
  const reconnected = await openChat(parentId);
  expect(parentCalls()).toBe(calls);
  expect(reconnected.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.source === 'inbox')).toHaveLength(1);
}, 20_000);

it('closes the notification for a report too long to inline', async () => {
  // The defect this pins: a worker report longer than the inline limit was
  // replaced by a preview before it reached the conversation, and the preview
  // carried no handover. Without a receipt the host kept waking the parent
  // about a report it had already read, every few minutes, forever.
  const { viewer, release, workerId, parentCalls } = await automaticWorkerFixture({ longReport: true });
  release();
  await vi.waitFor(() =>
    expect(
      viewer.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text === 'PARENT_RESULT_INTEGRATED'),
    ).toBe(true),
  );
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const { readWorkerRecord } = await import('../src/worker-records.js');
  const reader = new ActivityLedger(join(root, 'state.db'), { readOnly: true });
  try {
    // The receipt is written when the session is saved, so the report cannot
    // be "read" before its content is durable.
    await vi.waitFor(() => expect(readWorkerRecord(reader, workerId)?.reportedRevision).toBe(1));
    const event = reader.listEvents().find((entry) => entry.source === 'worker' && entry.payload.workerId === workerId)!;
    expect(event.status).toBe('delivered');
  } finally {
    reader.close();
  }
  // One wake, and no second one: the parent is not called about a report it
  // has already read.
  const calls = parentCalls();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(parentCalls()).toBe(calls);
}, 20_000);

it.each(['terminal', 'telegram'])(
  'keeps %s images in the session folder until the agent explicitly opens them',
  async (channel) => {
    fixtureVision = true;
    if (channel === 'telegram') {
      const settings = await import('../src/settings.js');
      const store = settings.defaultSettings();
      store.telegram = { enabled: true, tokenEnv: 'ATTACHMENT_TEST_TOKEN_NOT_CONFIGURED', workspaceRoot: root, chatId: '1', userId: '2' };
      settings.saveSettings(store);
      // The custodian is installed with the host, so its runtime is built at start.
      registry = new FixtureRegistry();
    }
    const { createReadTool } = await import('../src/tools/file-read.js');
    registry.register(createReadTool(['image'], root));
    // Start the host again now that this machine's model is known to read images, so the
    // custodian runtime is built with the tool.
    if (channel === 'telegram') await replaceFixtureHost();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C9sAAAAASUVORK5CYII=', 'base64');
    const { loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    const viewer = await newChat();
    // Telegram drives the custodian, so that conversation is the one holding the attachment.
    const sessionId = channel === 'terminal' ? viewer.getSnapshot().session.id : CUSTODIAN_SESSION_ID;
    const sessionEntries = () =>
      channel === 'terminal' ? viewer.getSnapshot().session.entries : (loadSavedSession(CUSTODIAN_SESSION_ID)?.entries ?? []);
    let requestedRead = false;
    let filePath = '';
    model.doStream = vi.fn(
      async (options: { prompt?: Array<{ role: string; content: string | Array<{ type: string; text?: string; data?: unknown }> }> }) => {
        const messages = options.prompt ?? [];
        const files = messages.flatMap((message) =>
          Array.isArray(message.content) ? message.content.filter((part) => part.type === 'file') : [],
        );
        if (requestedRead) {
          if (files.length) expect(Buffer.from(files[0]!.data as Uint8Array)).toEqual(bytes);
          else expect(JSON.stringify(messages)).toContain(bytes.toString('base64'));
          return textStream('IMAGE_WAS_OPENED');
        }
        expect(files).toHaveLength(0);
        expect(JSON.stringify(messages)).not.toContain(bytes.toString('base64'));
        const lines = messages
          .filter((message) => message.role === 'user')
          .flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])),
          )
          .flatMap((text) => text.split('\n'));
        const mapping = lines.find((line) => line.startsWith('[image#1='));
        if (!mapping)
          return stream(
            [
              {
                type: 'tool-call',
                toolCallId: 'read-notification',
                toolName: 'inbox',
                input: JSON.stringify({ action: 'read', ids: [await firstInboxId(sessionId, 'Telegram')] }),
              },
            ],
            'tool-calls',
          );
        filePath = JSON.parse(mapping.slice('[image#1='.length, -1)) as string;
        expect(dirname(filePath)).toBe(join(root, 'sessions', sessionId, 'attachments'));
        requestedRead = true;
        return stream(
          [{ type: 'tool-call', toolCallId: 'open-image', toolName: 'file_read', input: JSON.stringify({ path: filePath }) }],
          'tool-calls',
        );
      },
    );
    if (channel === 'terminal')
      await viewer.sendMessage({
        text: '[image#1] Inspect this reference.',
        images: [{ base64: bytes.toString('base64'), mediaType: 'image/png' }],
      });
    else
      await host.receiveTelegramMessage(999, '[image#1] Inspect this reference.', {
        image: { bytes, filename: 'reference.png', mediaType: 'image/png' },
      });
    await vi.waitFor(() =>
      expect(sessionEntries().some((entry) => entry.kind === 'assistant' && entry.text === 'IMAGE_WAS_OPENED')).toBe(true),
    );
    expect(readFileSync(filePath)).toEqual(bytes);
    if (channel === 'terminal') await viewer.flushSave();
    expect(existsSync(join(root, 'sessions', sessionId, `${sessionId}.json`))).toBe(true);
    expect(existsSync(join(root, 'attachments'))).toBe(false);
    // Opening the notification is the only consumption step there is, so the
    // session-owned attachment must survive it.
    expect(existsSync(filePath)).toBe(true);
  },
  20_000,
);
