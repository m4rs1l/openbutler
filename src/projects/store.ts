import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { getDataPath } from '../paths.js';
import type { Project, ProjectContext, SessionProject } from './types.js';

type StoredProject = Omit<Project, 'available'>;
const MAX_PROJECTS = 200;
const MAX_FOLDERS = 16;
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

export class ProjectInputError extends Error {}
export function sessionProject(id: string | null, fallbackRoot?: string): SessionProject {
  const scope = resolveProjectSelection(id, fallbackRoot);
  return {
    id,
    name: scope.projectContext?.name ?? null,
    folders: scope.projectContext?.folders ?? [],
    workspaceRoot: scope.workspaceRoot,
    locked: false,
  };
}

export function projectFolder(path: unknown): string {
  if (typeof path !== 'string' || path.length > 32768 || !isAbsolute(path) || path.includes('\0'))
    throw new ProjectInputError('Choose an absolute folder path.');
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory');
    return canonical;
  } catch {
    throw new ProjectInputError(`Cannot reach the folder: ${path}`);
  }
}

function readProjects(): StoredProject[] {
  let text: string;
  try {
    text = readFileSync(getDataPath('projects.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (
    !data ||
    typeof data !== 'object' ||
    !('version' in data) ||
    data.version !== 1 ||
    !('projects' in data) ||
    !Array.isArray(data.projects)
  )
    throw new Error('The project record file is invalid.');
  if (
    data.projects.length > MAX_PROJECTS ||
    !data.projects.every((project: unknown) => {
      if (!project || typeof project !== 'object') return false;
      const item = project as Record<string, unknown>;
      return (
        typeof item.id === 'string' &&
        /^[a-f0-9-]{36}$/.test(item.id) &&
        typeof item.name === 'string' &&
        item.name.trim().length > 0 &&
        item.name.length <= 80 &&
        typeof item.createdAt === 'string' &&
        Array.isArray(item.folders) &&
        item.folders.length > 0 &&
        item.folders.length <= MAX_FOLDERS &&
        item.folders.every((folder: unknown) => typeof folder === 'string' && isAbsolute(folder))
      );
    })
  )
    throw new Error('The project record file is invalid.');
  return data.projects as StoredProject[];
}

function available(project: StoredProject): boolean {
  try {
    for (const folder of project.folders) projectFolder(folder);
    return true;
  } catch {
    return false;
  }
}

export function listProjects(): Project[] {
  return readProjects().map((project) => ({ ...project, available: available(project) }));
}

/**
 * The owner types the name; a folder path never names a project. Every write
 * goes through these two validators, so create and update cannot drift apart.
 */
function projectName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value))
    throw new ProjectInputError('A project name must be 1 to 80 characters.');
  return value.trim();
}

function projectFolders(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FOLDERS)
    throw new ProjectInputError(`Add 1 to ${MAX_FOLDERS} source folders.`);
  const unique = new Map<string, string>();
  for (const folder of value) {
    const canonical = projectFolder(folder);
    unique.set(key(canonical), canonical);
  }
  return [...unique.values()];
}

function assertNameFree(projects: readonly StoredProject[], name: string, exceptId?: string): void {
  const wanted = name.toLowerCase();
  if (projects.some((project) => project.id !== exceptId && project.name.toLowerCase() === wanted))
    throw new ProjectInputError('A project with this name already exists.');
}

/** One atomic write path: temp file, then rename. Both mutations use it. */
function writeProjects(projects: readonly StoredProject[]): void {
  const file = getDataPath('projects.json');
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, projects }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the write error; an uncommitted temp file is recoverable. */
    }
    throw error;
  }
}

export function createProject(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new ProjectInputError('Enter the project details.');
  const { name, folders } = input as Record<string, unknown>;
  const ownerName = projectName(name);
  const ownerFolders = projectFolders(folders);
  const projects = readProjects();
  if (projects.length >= MAX_PROJECTS) throw new ProjectInputError('The project limit has been reached.');
  assertNameFree(projects, ownerName);
  const project: StoredProject = {
    id: randomUUID(),
    name: ownerName,
    folders: ownerFolders,
    createdAt: new Date().toISOString(),
  };
  writeProjects([...projects, project]);
  return { ...project, available: true };
}

/**
 * Rename or repoint an existing project. The name stays whatever the owner
 * typed - editing folders never rewrites it - and id and createdAt are stable,
 * so chats already bound to the project keep pointing at it.
 */
export function updateProject(id: unknown, input: unknown): Project {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new ProjectInputError('Project not found.');
  if (!input || typeof input !== 'object') throw new ProjectInputError('Enter the project details.');
  const { name, folders } = input as Record<string, unknown>;
  if (name === undefined && folders === undefined) throw new ProjectInputError('Nothing to update.');
  const projects = readProjects();
  const index = projects.findIndex((project) => project.id === id);
  if (index < 0) throw new ProjectInputError('Project not found.');
  const current = projects[index]!;
  const nextName = name === undefined ? current.name : projectName(name);
  const nextFolders = folders === undefined ? current.folders : projectFolders(folders);
  assertNameFree(projects, nextName, id);
  const updated: StoredProject = { ...current, name: nextName, folders: nextFolders };
  projects[index] = updated;
  writeProjects(projects);
  return { ...updated, available: available(updated) };
}

/** Resolve once at queue admission. A queued turn keeps the owner's chosen scope. */
/**
 * The scope a chat runs in. A selected project wins with its first folder;
 * without one the caller's own scope wins, because "no project" must mean the
 * directory the client attached with (the launch scope), never a folder the
 * owner never chose. The scratch folder stays as the last resort for a caller
 * that owns no scope at all, so nothing can resolve to an empty path.
 */
export function resolveProjectSelection(id: unknown, fallbackRoot?: string): { workspaceRoot: string; projectContext?: ProjectContext } {
  if (id === null) {
    if (typeof fallbackRoot === 'string' && fallbackRoot.length > 0) return { workspaceRoot: projectFolder(fallbackRoot) };
    const folder = getDataPath('workspace');
    mkdirSync(folder, { recursive: true });
    return { workspaceRoot: projectFolder(folder) };
  }
  if (typeof id !== 'string') throw new ProjectInputError('Invalid project selection.');
  const project = readProjects().find((item) => item.id === id);
  if (!project) throw new ProjectInputError('Project not found.');
  const folders = project.folders.map(projectFolder);
  return { workspaceRoot: folders[0]!, projectContext: { id: project.id, name: project.name, folders } };
}
