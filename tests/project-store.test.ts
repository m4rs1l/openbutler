import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The catalog is the authority for a project's name: the owner types it, a
 * folder path never derives it, and editing folders must not rewrite it.
 */

let dataDir: string;
let folders: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-project-store-'));
  folders = [mkdtempSync(join(tmpdir(), 'openbutler-project-src-'))];
  vi.stubEnv('OPENBUTLER_DATA_DIR', dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function store() {
  return await import('../src/projects/store.js');
}

describe('project name authority', () => {
  it('keeps the typed name even when the folder is named differently', async () => {
    const { createProject, listProjects } = await store();
    const project = createProject({ name: 'Voice Lab', folders: [folders[0]!] });
    expect(project.name).toBe('Voice Lab');
    expect(project.folders[0]!.toLowerCase()).not.toBe('voice lab');
    expect(listProjects()[0]!.name).toBe('Voice Lab');
  });

  it('stores the trimmed name and the canonical folder', async () => {
    const { createProject } = await store();
    const project = createProject({ name: '  mindbox  ', folders: [folders[0]!] });
    expect(project.name).toBe('mindbox');
    expect(project.folders).toEqual([folders[0]!]);
  });

  it('rejects a name that is empty or too long', async () => {
    const { createProject, ProjectInputError } = await store();
    expect(() => createProject({ name: '   ', folders: [folders[0]!] })).toThrow(ProjectInputError);
    expect(() => createProject({ name: 'x'.repeat(81), folders: [folders[0]!] })).toThrow(/1 to 80/);
  });
});

describe('updateProject', () => {
  it('renames without touching the id, createdAt or folders', async () => {
    const { createProject, updateProject, listProjects } = await store();
    const created = createProject({ name: 'ranite', folders: [folders[0]!] });
    const updated = updateProject(created.id, { name: 'openbutler' });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'openbutler',
      folders: created.folders,
      createdAt: created.createdAt,
    });
    expect(listProjects().map((project) => project.name)).toEqual(['openbutler']);
  });

  it('repoints the folders without rewriting a name the owner typed', async () => {
    const { createProject, updateProject, listProjects } = await store();
    const other = mkdtempSync(join(tmpdir(), 'openbutler-project-src-'));
    folders.push(other);
    const created = createProject({ name: 'Voice Lab', folders: [folders[0]!] });
    const updated = updateProject(created.id, { folders: [other] });
    expect(updated.name).toBe('Voice Lab');
    expect(updated.folders).toEqual([other]);
    expect(listProjects()[0]!.name).toBe('Voice Lab');
  });

  it('refuses a name another project already holds, but accepts its own', async () => {
    const { createProject, updateProject, ProjectInputError } = await store();
    createProject({ name: 'Alpha', folders: [folders[0]!] });
    const beta = createProject({ name: 'Beta', folders: [folders[0]!] });
    expect(() => updateProject(beta.id, { name: 'alpha' })).toThrow(ProjectInputError);
    expect(updateProject(beta.id, { name: 'BETA' }).name).toBe('BETA');
  });

  it('rejects an unknown id and an empty change', async () => {
    const { updateProject } = await store();
    expect(() => updateProject('not-a-project', { name: 'Ghost' })).toThrow(/not found/i);
    expect(() => updateProject('00000000-0000-0000-0000-000000000000', {})).toThrow(/nothing to update/i);
  });

  it('leaves the record file valid when a change is refused', async () => {
    const { createProject, updateProject } = await store();
    createProject({ name: 'Alpha', folders: [folders[0]!] });
    const beta = createProject({ name: 'Beta', folders: [folders[0]!] });
    expect(() => updateProject(beta.id, { name: 'alpha' })).toThrow();
    const stored = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')) as { version: number };
    expect(stored.version).toBe(1);
    expect(JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')).projects).toHaveLength(2);
  });
});
