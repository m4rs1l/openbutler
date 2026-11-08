/** Presentation only: tool inputs are stored once, in full. */
import { formatToolInput } from './tool-input.js';
export const DEFAULT_SESSION_LIST_LIMIT = 20;

export interface ToolEntryDisplay {
  tool?: string;
  toolTitle?: string;
  preparing?: boolean;
  running?: boolean;
  /** Legacy summaries, also used while arguments are still streaming. */
  command?: string;
  input?: Record<string, unknown>;
}

export function toolEntryCommand(entry: ToolEntryDisplay): string {
  if (entry.toolTitle !== undefined) return entry.toolTitle;
  if (!entry.input || !entry.tool) return entry.command || entry.tool || 'tool';
  const colon = entry.tool.indexOf(':');
  return toolDisplayCommand({ providerId: entry.tool.slice(0, colon), name: entry.tool.slice(colon + 1), input: entry.input });
}

export function toolEntryDetails(entry: ToolEntryDisplay): string {
  return entry.input ? JSON.stringify(entry.input, null, 2) : entry.command || entry.tool || 'tool';
}

/** Keys each built-in's human display covers, so the faithful tail never repeats them. */
const BUILTIN_SHOWN: Record<string, readonly string[]> = {
  inbox: ['action', 'source'],
  execute_command: ['command'],
  file_read: ['path', 'offset', 'limit'],
  file_write: ['path'],
  file_edit: ['path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  question: ['question', 'options'],
  memory_search: ['query'],
  session_list: ['scope', 'limit'],
  session_search: ['query'],
  session_read: ['session', 'offset', 'limit'],
  session_message: ['session', 'text'],
  parent_message: ['text'],
  subagent: ['mode', 'task'],
  subagent_poll: ['session'],
  subagent_stop: ['session'],
  schedule: ['action', 'scheduleId'],
  mcp_manage: ['action', 'serverId'],
};

/**
 * The expanded tool row's one-line truth: the curated headline, plus whatever it
 * did not show — always, in full. Built-ins get their curated line; everything
 * else (MCP, server-provided, future tools) falls back to the complete generic
 * render, so no input is ever hidden or trimmed on this surface.
 */
export function toolEntryInput(entry: ToolEntryDisplay): string {
  if (!entry.input) return entry.command || entry.tool || 'tool';
  if (!entry.tool) return formatToolInput(entry.input);
  const colon = entry.tool.indexOf(':');
  const providerId = entry.tool.slice(0, colon);
  const name = entry.tool.slice(colon + 1);
  const shown = providerId === 'host' ? BUILTIN_SHOWN[name] : undefined;
  if (shown === undefined) return formatToolInput(entry.input);
  const headline = toolDisplayCommand({ providerId, name, input: entry.input });
  const wanted = new Set(shown);
  const rest = Object.entries(entry.input).filter(([key]) => !wanted.has(key));
  if (rest.length === 0) return headline;
  const rendered = formatToolInput(Object.fromEntries(rest));
  return `${headline} · ${rendered}`;
}

export function toolDisplayCommand(request: { providerId: string; name: string; input: Record<string, unknown>; title?: string }): string {
  if (request.title !== undefined) return request.title;
  if (request.providerId === 'host') {
    const input = request.input;
    switch (request.name) {
      case 'inbox':
        return `Inbox ${String(input.action ?? 'list')}${typeof input.source === 'string' ? ` · ${input.source}` : ''}`;
      case 'execute_command':
        if (typeof input.command === 'string') return input.command;
        break;
      case 'file_read': {
        if (typeof input.path !== 'string') break;
        const offset = typeof input.offset === 'number' ? input.offset : 1;
        const range =
          typeof input.offset === 'number' || typeof input.limit === 'number'
            ? `:${offset}-${typeof input.limit === 'number' ? offset + input.limit - 1 : '…'}`
            : '';
        return `Read ${input.path}${range}`;
      }
      case 'file_write': {
        if (typeof input.path !== 'string') break;
        return `Write ${input.path}`;
      }
      case 'file_edit': {
        if (typeof input.path !== 'string') break;
        return `Edit ${input.path}`;
      }
      case 'glob': {
        if (typeof input.pattern !== 'string') break;
        const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
        return `Glob ${input.pattern}${source}`;
      }
      case 'grep': {
        if (typeof input.pattern !== 'string') break;
        const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
        return `Grep ${input.pattern}${source}`;
      }
      case 'question': {
        const question = typeof input.question === 'string' ? singleLine(input.question) : undefined;
        if (question === undefined) break;
        const options = Array.isArray(input.options) ? input.options.filter((option): option is string => typeof option === 'string') : [];
        const shown = options
          .map((option) => singleLine(option))
          .filter((option) => option !== undefined)
          .join(' · ');
        return shown ? `Ask "${question}" [${shown}]` : `Ask "${question}"`;
      }
      case 'memory_search': {
        const query = typeof input.query === 'string' ? singleLine(input.query) : undefined;
        if (query === undefined) break;
        return `Search memory "${query}"`;
      }
      case 'session_list': {
        const scope = input.scope === 'workspace' ? 'workspace' : 'all';
        const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_SESSION_LIST_LIMIT;
        return `Sessions ${scope} · ${limit}`;
      }
      case 'session_search': {
        const query = typeof input.query === 'string' ? singleLine(input.query) : undefined;
        if (query === undefined) break;
        return `Search sessions "${query}"`;
      }
      case 'session_read': {
        if (typeof input.session !== 'string' || !input.session) break;
        const offset = typeof input.offset === 'number' ? input.offset : 1;
        const range =
          typeof input.offset === 'number' || typeof input.limit === 'number'
            ? `:${offset}-${typeof input.limit === 'number' ? offset + input.limit - 1 : '…'}`
            : '';
        return `Read session ${input.session.slice(0, 8)}${range}`;
      }
      case 'session_message': {
        if (typeof input.session !== 'string' || !input.session) break;
        const text = typeof input.text === 'string' ? singleLine(input.text) : undefined;
        return text === undefined ? `Message ${input.session.slice(0, 8)}` : `Message ${input.session.slice(0, 8)} "${text}"`;
      }
      case 'parent_message': {
        const text = typeof input.text === 'string' ? singleLine(input.text) : undefined;
        if (text === undefined) break;
        return `Note "${text}"`;
      }
      case 'subagent': {
        const mode = input.mode === 'explorer' ? 'explorer' : 'executor';
        const task = typeof input.task === 'string' ? singleLine(input.task) : '';
        return `subagent ${mode}${task ? ` · ${task}` : ''}`;
      }
      case 'subagent_poll': {
        if (typeof input.session !== 'string' || !input.session) break;
        return `Poll ${input.session.slice(0, 8)}`;
      }
      case 'subagent_stop': {
        if (typeof input.session !== 'string' || !input.session) break;
        return `Stop ${input.session.slice(0, 8)}`;
      }
      case 'schedule': {
        if (typeof input.action !== 'string') break;
        const id = typeof input.scheduleId === 'string' && input.scheduleId ? ` ${input.scheduleId.slice(0, 8)}` : '';
        return `Schedule ${input.action}${id}`;
      }
      case 'mcp_manage': {
        return [request.name, input.action, input.serverId].filter((part) => typeof part === 'string').join(' ');
      }
    }
  }
  return `${request.providerId}/${request.name} ${displayInputSummary(request.input)}`;
}

function displayInputSummary(input: Record<string, unknown>): string {
  const summary = JSON.stringify(input);
  return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
}

function singleLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length === 0 ? undefined : single;
}
