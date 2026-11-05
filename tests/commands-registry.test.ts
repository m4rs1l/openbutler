import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  commandMenu,
  daemonCommandAction,
  findCommand,
  matchCommand,
  commandQuery,
  suggestCommands,
} from '../src/commands/registry.js';

describe('slash command registry', () => {
  it('keeps every name unique', () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('requires a daemon command to name the request it resolves to', () => {
    for (const command of COMMANDS) {
      if (command.effect === 'daemon') expect(command.daemonAction).toBeTruthy();
      else expect(command.daemonAction).toBeUndefined();
    }
  });

  it('offers only the commands a surface can carry out', () => {
    expect(commandMenu('web').map(({ command }) => command)).toEqual([
      '/help',
      '/new',
      '/settings',
      '/permissions',
      '/reasoning',
      '/compact',
      '/stop',
      '/models',
      '/provider',
      '/session',
    ]);
    // /skills reads the local filesystem and /exit closes a terminal.
    expect(commandMenu('cli').map(({ command }) => command)).toContain('/skills');
    expect(commandMenu('cli').map(({ command }) => command)).toContain('/exit');
    expect(commandMenu('web').map(({ command }) => command)).not.toContain('/exit');
  });
});

describe('commandQuery', () => {
  it('reads the leading token', () => {
    expect(commandQuery('/com')).toEqual({ token: '/com', bare: true });
    expect(commandQuery('  /com')).toEqual({ token: '/com', bare: true });
    expect(commandQuery('/com p')).toEqual({ token: '/com', bare: false });
    expect(commandQuery('/com\np')).toEqual({ token: '/com', bare: false });
  });

  it('leaves ordinary text alone', () => {
    expect(commandQuery('hello')).toBeNull();
    expect(commandQuery('')).toBeNull();
    expect(commandQuery('/')).toEqual({ token: '/', bare: true });
  });
});

describe('suggestCommands', () => {
  it('lists the surface menu on a bare slash', () => {
    expect(suggestCommands('/', 'web').map((command) => command.name)).toEqual([
      '/help',
      '/new',
      '/settings',
      '/permissions',
      '/reasoning',
      '/compact',
      '/stop',
      '/models',
      '/provider',
      '/session',
    ]);
  });

  it('narrows by prefix', () => {
    expect(suggestCommands('/c', 'cli').map((command) => command.name)).toEqual(['/compact']);
    expect(suggestCommands('/n', 'cli').map((command) => command.name)).toEqual(['/new']);
    expect(suggestCommands('/sett', 'cli').map((command) => command.name)).toEqual(['/settings']);
    expect(suggestCommands('/zzz', 'cli')).toEqual([]);
  });

  it('stops offering commands once an argument follows', () => {
    expect(suggestCommands('/compact now', 'cli')).toEqual([]);
  });
});

describe('matchCommand', () => {
  it('runs only a command that stands alone', () => {
    expect(matchCommand('/compact', 'cli')?.name).toBe('/compact');
    expect(matchCommand('/compact', 'web')?.name).toBe('/compact');
    // A slash mid-sentence belongs to the model, not the interface.
    expect(matchCommand('/compact now', 'cli')).toBeNull();
    expect(matchCommand('explain /compact', 'cli')).toBeNull();
    expect(matchCommand('/nope', 'cli')).toBeNull();
  });

  it('refuses a command the surface does not offer', () => {
    expect(matchCommand('/exit', 'web')).toBeNull();
    expect(matchCommand('/skills', 'web')).toBeNull();
    expect(matchCommand('/exit', 'cli')?.name).toBe('/exit');
  });
});

describe('daemonCommandAction', () => {
  it('maps a daemon command to its request', () => {
    expect(daemonCommandAction('/compact')).toBe('session.compact');
    expect(daemonCommandAction('/new')).toBe('session.new');
    // The old name is gone rather than aliased: one command, one spelling.
    expect(daemonCommandAction('/clear')).toBeNull();
    expect(daemonCommandAction('/stop')).toBe('session.stop');
  });

  it('never resolves a surface command', () => {
    expect(daemonCommandAction('/settings')).toBeNull();
    expect(daemonCommandAction('/exit')).toBeNull();
    expect(daemonCommandAction('/nope')).toBeNull();
  });

  it('keeps findCommand and the mapping consistent', () => {
    for (const command of COMMANDS) {
      expect(daemonCommandAction(command.name)).toBe(command.effect === 'daemon' ? (command.daemonAction ?? null) : null);
      expect(findCommand(command.name)).toBe(command);
    }
    expect(findCommand('/nope')).toBeNull();
  });
});
