/**
 * The vocabulary every surface uses to address a slash command.
 *
 * This module is data and pure helpers, never behavior: it says which commands
 * exist, what each is called, where it is offered, and where its effect lives.
 * The effects themselves stay behind the daemon's `session.command`, so a
 * client names a command instead of deciding what the name means.
 *
 * Deliberately dependency-free (no node, no React, no Ink): the CLI, the daemon
 * and the web bundle all import it, so it must stay safe anywhere.
 */

/** A surface that can offer a command menu. */
export type CommandSurface = 'cli' | 'web';

/** The daemon request a `daemon` command resolves to. */
export type DaemonCommandAction = 'session.compact' | 'session.new' | 'session.stop';

export interface CommandSpec {
  /** The exact text the owner types, leading slash included. */
  readonly name: string;
  /** One line shown beside the name in a menu. */
  readonly description: string;
  /**
   * Where the effect runs. `daemon` commands resolve through `session.command`,
   * which validates the name against this registry before touching a session.
   * `surface` commands only move something inside the interface that asked — a
   * panel, a notice, a window — and the daemon has no part in them.
   */
  readonly effect: 'daemon' | 'surface';
  /** Set only for `daemon`: the request the daemon re-dispatches to. */
  readonly daemonAction?: DaemonCommandAction;
  /** Surfaces that offer this command at all. */
  readonly surfaces: readonly CommandSurface[];
}

/**
 * One list, shared by every menu. Descriptions are the CLI's own wording so the
 * same command reads the same everywhere it is offered.
 *
 * A command joins a surface's `surfaces` only when that surface can actually
 * carry it out: `/skills` reads the local filesystem and `/exit` closes a
 * terminal, so neither belongs on the web, which has no way to do either.
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: '/help', description: 'Show available commands', effect: 'surface', surfaces: ['cli', 'web'] },
  { name: '/new', description: 'Start a new chat', effect: 'daemon', daemonAction: 'session.new', surfaces: ['cli', 'web'] },
  { name: '/settings', description: 'Open settings', effect: 'surface', surfaces: ['cli', 'web'] },
  {
    name: '/permissions',
    description: 'Choose workspace, auto-review, or full-access mode',
    effect: 'surface',
    surfaces: ['cli', 'web'],
  },
  { name: '/reasoning', description: 'Choose model reasoning', effect: 'surface', surfaces: ['cli', 'web'] },
  { name: '/thinking', description: 'Show or hide reasoning text', effect: 'surface', surfaces: ['cli'] },
  {
    name: '/compact',
    description: 'Summarize the complete model context',
    effect: 'daemon',
    daemonAction: 'session.compact',
    surfaces: ['cli', 'web'],
  },
  {
    name: '/stop',
    description: 'Stop the current run and keep queued messages',
    effect: 'daemon',
    daemonAction: 'session.stop',
    surfaces: ['cli', 'web'],
  },
  { name: '/models', description: 'Choose a model from configured providers', effect: 'surface', surfaces: ['cli', 'web'] },
  { name: '/provider', description: 'Add a provider, API key, and model', effect: 'surface', surfaces: ['cli', 'web'] },
  { name: '/session', description: 'Search and open a saved session', effect: 'surface', surfaces: ['cli', 'web'] },
  { name: '/skills', description: 'List available global and workspace skills', effect: 'surface', surfaces: ['cli'] },
  {
    name: '/exit',
    description: 'Close this terminal UI; the background host keeps running',
    effect: 'surface',
    surfaces: ['cli'],
  },
];

/** The spec behind a name, or null when the name is not part of the vocabulary. */
export function findCommand(name: string): CommandSpec | null {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

/**
 * The daemon request a `daemon` command re-dispatches to, or null for an
 * unknown name or one whose effect belongs to a surface. This is the single
 * name-to-effect mapping: the daemon uses it to normalize `session.command`,
 * and nothing else in the codebase is allowed to restate it.
 */
export function daemonCommandAction(name: string): DaemonCommandAction | null {
  const spec = findCommand(name);
  return spec && spec.effect === 'daemon' && spec.daemonAction ? spec.daemonAction : null;
}

/** The menu a surface shows: its own commands, in registry order. */
export function commandMenu(surface: CommandSurface): Array<{ command: string; description: string }> {
  return COMMANDS.filter((command) => command.surfaces.includes(surface)).map((command) => ({
    command: command.name,
    description: command.description,
  }));
}

/** A command offered to a surface, or null when the surface cannot run it. */
export function commandFor(name: string, surface: CommandSurface): CommandSpec | null {
  const spec = findCommand(name);
  return spec && spec.surfaces.includes(surface) ? spec : null;
}

export interface CommandQuery {
  /** The leading token, whitespace already cut. */
  readonly token: string;
  /** True while nothing follows the token: the menu is still choosing, not typing an argument. */
  readonly bare: boolean;
}

/**
 * The command being typed, or null when the draft is ordinary text.
 *
 * Only a leading `/` opens a menu, and only the first token counts: an editor
 * asking the model to "explain /compact in detail" is a message, not a command.
 */
export function commandQuery(draft: string): CommandQuery | null {
  const text = draft.trim();
  if (!text.startsWith('/')) return null;
  const split = text.search(/\s/);
  // A trailing space is not an argument: the menu stays up until words follow.
  return { token: split === -1 ? text : text.slice(0, split), bare: split === -1 };
}

/**
 * Commands matching what has been typed so far.
 *
 * `query` is the whole draft; the leading token decides the match, so `/com`
 * narrows to `/compact` and `/` lists everything the surface offers. The menu
 * only exists while that token stands alone — the moment a space follows, the
 * owner has moved on from choosing a command.
 */
export function suggestCommands(query: string, surface: CommandSurface): CommandSpec[] {
  const parsed = commandQuery(query);
  if (!parsed || !parsed.bare) return [];
  return commandMenu(surface)
    .filter(({ command }) => command.startsWith(parsed.token))
    .map(({ command }) => commandFor(command, surface)!)
    .filter((command): command is CommandSpec => command !== null);
}

/**
 * The text that resolves to a runnable command, or null when the draft must
 * reach the model as an ordinary message.
 *
 * A command only counts when it stands alone: `/compact now` is a request that
 * happens to start with a slash, and it belongs to the model.
 */
export function matchCommand(draft: string, surface: CommandSurface): CommandSpec | null {
  const parsed = commandQuery(draft);
  if (!parsed || !parsed.bare) return null;
  return commandFor(parsed.token, surface);
}
