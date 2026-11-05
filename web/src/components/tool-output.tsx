import { useState } from 'react';
import { isShellTool } from '../turns.js';
import { ScrollArea } from './scroll-area.js';
import type { Entry } from '../types.js';
import { StreamText } from './stream-text.js';
import { toolEntryCommand, toolEntryInput } from '../../../src/tool-display.js';

/** How much of the command stays visible before the reader taps to read the rest. */
const COLLAPSED_COMMAND_CHARS = 140;

export function ToolOutput({ entry, running }: { entry: Entry; running: boolean }) {
  const shell = isShellTool(entry);
  const raw = toolEntryCommand(entry).trim();
  const space = raw.indexOf(' ');
  const verb = space === -1 ? raw : raw.slice(0, space);
  const target = space === -1 ? '' : raw.slice(space + 1);
  // A shell command is the whole line and reads better under a prompt glyph. A
  // file tool repeats its own verb ("Read <path>"), which is already the title,
  // so only the target is printed and the line stops being a second heading.
  const title = entry.toolTitle ?? (shell ? 'Shell' : verb || entry.tool || 'Tool');
  // The one source of truth for what the model is about to run: curated for
  // built-ins, fully generic for anything else (MCP, future tools). No JSON
  // ceremony, nothing hidden.
  const command = entry.input ? toolEntryInput(entry) : entry.toolTitle !== undefined ? '' : shell ? raw : target;
  const oneLine = command.replace(/\s+/g, ' ').trim();
  const collapsible = oneLine.length > COLLAPSED_COMMAND_CHARS;
  const [expanded, setExpanded] = useState(false);
  return (
    <ScrollArea className="tool-output" role="region" aria-label={`${title} output`} tabIndex={0} follow={running}>
      <div className="tool-output-title">{title}</div>
      {command ? (
        collapsible ? (
          <button
            type="button"
            className="tool-output-command expandable"
            data-expanded={expanded}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? 'Collapse' : 'Read the whole command'}
          >
            {shell ? <span className="shell-prompt">$ </span> : null}
            {expanded ? command : `${oneLine.slice(0, COLLAPSED_COMMAND_CHARS).trimEnd()}…`}
          </button>
        ) : (
          <pre className="tool-output-command">
            {shell ? <span className="shell-prompt">$ </span> : null}
            {command}
          </pre>
        )
      ) : null}
      {entry.result || running ? <div className="tool-output-title">Output</div> : null}
      <pre className="tool-output-result">
        {entry.result ? <StreamText text={entry.result} ranges={entry.streamReveal} /> : running ? 'Running…' : 'No output.'}
      </pre>
    </ScrollArea>
  );
}
