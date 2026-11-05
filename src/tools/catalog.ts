import type { InboxRequest } from '../inbox.js';
import type { MemoryIndex } from '../memory-index.js';
import { createScheduleTool } from './schedule.js';
import { createExecuteCommandTool } from './execute-command.js';
import { createEditTool } from './file-edit.js';
import { createReadTool } from './file-read.js';
import { createGlobTool, createGrepTool } from './file-search.js';
import { createWriteTool } from './file-write.js';
import { createMcpManagementTool, type McpConnectionManager } from './mcp.js';
import { createMemorySearchTool } from './memory-search.js';
import { createMemoryWriteTool } from './memory-write.js';
import { createQuestionTool } from './question.js';
import { createSessionListTool } from './session-list.js';
import { createSessionReadTool } from './session-read.js';
import { createSessionSearchTool } from './session-search.js';
import { createInboxTool } from './inbox.js';
import { createSubagentStopTool } from './subagent-stop.js';
import { createSubagentTool, type SubagentRequest } from './subagent.js';
import type { ToolDefinition } from './registry.js';
import { createTeamProfileTool, createTeamWorkTool } from './team-coordination.js';
import {
  createTeamFilesTool,
  createTeamGroupTool,
  createTeamHistoryTool,
  createTeamReceiveFileTool,
  createTeamSendFileTool,
  createTeamSendTool,
  createTeamDeliveryTool,
  createTeamStatusTool,
} from './team-communication.js';

export interface ToolCatalogueOptions {
  workspaceRoot: string;
  inputModalities: readonly string[];
  memoryIndex: MemoryIndex;
  mcp: McpConnectionManager;
  /** Rebuilds the registry after an MCP connection change. */
  onMcpConnectionsChanged: () => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  inbox?: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>;
  teamDelivery?: (input: Record<string, unknown>) => Promise<unknown>;
  teamSend?: (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
  teamGroup?: (limit: number, acknowledge?: number) => Promise<unknown>;
  teamHistory?: (query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }) => Promise<unknown>;
  teamStatus?: () => Promise<unknown>;
  teamSendFile?: (input: { path: string; to: string }) => Promise<unknown>;
  teamReceiveFile?: (input: { id: string; to?: string }) => Promise<unknown>;
  teamFiles?: () => Promise<unknown>;
  teamProfile?: (input: Record<string, unknown>) => Promise<unknown>;
  teamWork?: (input: Record<string, unknown>) => Promise<unknown>;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  subagentStop?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
}

/**
 * The single place that decides which tools exist, in what order, and how the
 * native, memory, MCP, and background surfaces compose into one catalogue.
 * Definitions stay the mechanism; this module is the structure.
 *
 * Every session sees every tool in this catalogue, always. A missing host
 * handler is not a missing tool: the tool is still offered and answers
 * `unavailable` with the reason, so the model learns the boundary from one call
 * instead of guessing from an absent name. (A worker's toolkit is a registry of
 * its own, built from what its spawn granted; that narrowing is containment, not
 * a condition on sessions.)
 *
 * Tools that address one layer are not in here at all. The owner channel belongs
 * to the custodian, and messaging is named after its addressee, so those are
 * registered by the runtime that owns them (`src/agent-runtime.ts`), and every
 * other runtime is
 * unaware of the name rather than told it is unavailable. A tool listed but
 * refused is a promise with small print.
 */
export function createToolCatalogue(options: ToolCatalogueOptions): ToolDefinition[] {
  const unavailable = (name: string) => async () => ({
    status: 'unavailable' as const,
    error: `${name} is not available in this session. Work without it and say so if it blocks the goal.`,
  });
  const definitions: ToolDefinition[] = [
    createExecuteCommandTool(options.workspaceRoot),
    createReadTool(options.inputModalities, options.workspaceRoot),
    createWriteTool(options.workspaceRoot, options.memoryIndex),
    createEditTool(options.workspaceRoot, options.memoryIndex),
    createGlobTool(options.workspaceRoot),
    createGrepTool(options.workspaceRoot),
    createQuestionTool(),
    createMemorySearchTool(options.memoryIndex),
    createMemoryWriteTool(options.workspaceRoot, options.memoryIndex),
    createSessionListTool(options.workspaceRoot),
    createSessionSearchTool(options.workspaceRoot),
    createSessionReadTool(),
    createInboxTool(options.inbox ?? unavailable('inbox')),
    createTeamDeliveryTool(options.teamDelivery ?? (async () => ({ status: 'unavailable', error: 'Team delivery is not available.' }))),
    createTeamSendTool(options.teamSend ?? unavailable('team_send')),
    createTeamGroupTool(options.teamGroup ?? unavailable('team_group')),
    createTeamHistoryTool(options.teamHistory ?? unavailable('team_history')),
    createTeamStatusTool(options.teamStatus ?? unavailable('team_status')),
    createTeamSendFileTool(options.teamSendFile ?? unavailable('team_send_file')),
    createTeamReceiveFileTool(options.teamReceiveFile ?? unavailable('team_receive_file')),
    createTeamFilesTool(options.teamFiles ?? unavailable('team_files')),
    createTeamProfileTool(options.teamProfile ?? unavailable('team_profile')),
    createTeamWorkTool(options.teamWork ?? unavailable('team_work')),
    createSubagentTool(options.subagent ?? (async () => ({ status: 'unavailable' as const }))),
    createSubagentStopTool(options.subagentStop ?? (async () => ({ status: 'unavailable' as const }))),
    createScheduleTool(
      options.workspaceRoot,
      options.backgroundManage ??
        (async () => ({ status: 'unavailable' as const, error: 'No background host is attached to this session.' })),
    ),
    createMcpManagementTool(options.mcp, options.onMcpConnectionsChanged),
  ];
  definitions.push(
    ...options.mcp.tools.map(
      (definition) =>
        ({
          ...definition,
          execute: (input, signal, context) => definition.execute(input, signal, { ...context, inputModalities: options.inputModalities }),
        }) satisfies ToolDefinition,
    ),
  );
  return definitions;
}
