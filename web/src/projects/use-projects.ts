import { useEffect, useState } from 'react';
import { createProject, fetchProjects, updateProject } from '../api.js';
import type { Project, SessionPayload } from '../types.js';

/** Domain state is a server projection. Only request/error presentation lives here. */
export function useProjects(session: SessionPayload['session'] | undefined, requestSelection: (id: string | null) => Promise<void>) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [supportsSelection, setSupportsSelection] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProjects()
      .then((catalog) => {
        if (cancelled) return;
        setProjects(catalog.projects);
        setSupportsSelection(catalog.supportsSelection);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);
  const select = async (id: string | null) => {
    setSelecting(true);
    setSelectionError(null);
    try {
      await requestSelection(id);
      return true;
    } catch (problem) {
      setSelectionError(problem instanceof Error ? problem.message : String(problem));
      return false;
    } finally {
      setSelecting(false);
    }
  };
  const create = async (name: string, folders: string[]) => {
    const project = await createProject(name, folders);
    setProjects((previous) => (previous.some((item) => item.id === project.id) ? previous : [...previous, project]));
    // A created project opens: the host decides whether that means this chat or
    // a new chat in the project, and its refusal lands in selectionError where
    // the sidebar shows it - never a project that is created and then invisible.
    await select(project.id);
    return project;
  };
  const update = async (id: string, name: string, folders: string[]) => {
    const project = await updateProject(id, name, folders);
    setProjects((previous) => previous.map((item) => (item.id === project.id ? project : item)));
    return project;
  };
  const selectedProject = session?.project?.id ? projects.find((item) => item.id === session.project?.id) : undefined;
  return {
    projects,
    selectedId: session?.project?.id ?? null,
    selected: session?.project?.id
      ? {
          ...session.project,
          // The catalog is the authority for the name; the session keeps its own
          // binding snapshot only as a fallback for a project no longer listed.
          name: selectedProject?.name ?? session.project.name ?? null,
          folders: session.project.folders.length ? session.project.folders : (selectedProject?.folders ?? []),
        }
      : null,
    locked: session?.projectLocked === true,
    loading,
    selecting,
    error,
    selectionError,
    supportsSelection,
    select,
    create,
    update,
    refresh: () => setReload((value) => value + 1),
  };
}
export type ProjectController = ReturnType<typeof useProjects>;
