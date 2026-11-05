import { useState } from 'react';
import { pickProjectFolder, validateProjectFolder } from '../api.js';
import { Dialog } from '../components/dialog.js';
import { Icon } from '../components/icon.js';
import { IconButton } from '../components/ui.js';
import { Feedback } from '../components/feedback.js';
import { Dropdown } from '../components/selection/dropdown.js';
import type { ProjectController } from './use-projects.js';
import type { Project } from '../types.js';
import './projects.css';

/**
 * One dialog for both project mutations. The name field starts from the
 * catalog's name - never from a folder - so creating and editing read the same
 * way and the stored name always traces back to something the owner typed.
 */
export function ProjectDialog({ controller, project, onClose }: { controller: ProjectController; project?: Project; onClose: () => void }) {
  const editing = project !== undefined;
  const [name, setName] = useState(project?.name ?? '');
  const [folders, setFolders] = useState<string[]>(project?.folders ?? []);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addFolder = async (candidate?: string) => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = candidate ? await validateProjectFolder(candidate.trim()) : await pickProjectFolder();
      const folder = result.path;
      if (folder) {
        setFolders((previous) => (previous.includes(folder) ? previous : [...previous, folder]));
        setPath('');
        setManual(false);
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setManual(true);
    } finally {
      setPicking(false);
    }
  };
  const close = () => {
    if (!pending && !picking) onClose();
  };
  const title = editing ? 'Edit project' : 'Create project';
  return (
    <Dialog label={title} onClose={close} className="create-project">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || picking || !name.trim() || !folders.length) return;
          setPending(true);
          setError(null);
          try {
            if (project) await controller.update(project.id, name.trim(), folders);
            else await controller.create(name, folders);
            onClose();
          } catch (problem) {
            setError(problem instanceof Error ? problem.message : String(problem));
          } finally {
            setPending(false);
          }
        }}
      >
        <header className="create-project__header">
          <h1>{title}</h1>
          <IconButton icon="x" label="Close" onClick={close} disabled={pending || picking} />
        </header>
        <label className="create-project__name">
          <Icon name="folder" size={16} />
          <input
            autoFocus
            data-dialog-autofocus
            aria-label="Project name"
            placeholder="Project name"
            maxLength={80}
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <h2>Source folders</h2>
        <div className="create-project__sources">
          {folders.map((folder, index) => (
            <div className="create-project__folder" key={folder}>
              <Icon name="folder" size={16} />
              <span title={folder}>
                {folder}
                {index === 0 ? <small>Main folder</small> : null}
              </span>
              <IconButton
                icon="x"
                label={`Remove ${folder} folder`}
                disabled={pending || picking}
                onClick={() => setFolders((previous) => previous.filter((item) => item !== folder))}
              />
            </div>
          ))}
          <Dropdown
            ariaLabel="Source folder method"
            placement="bottom"
            align="center"
            items={[
              {
                id: 'picker',
                label: 'Choose folder',
                leading: <Icon name="folder-open" size={15} />,
                onSelect: () => {
                  void addFolder();
                },
              },
              {
                id: 'path',
                label: 'Enter folder path',
                leading: <Icon name="text-cursor-input" size={15} />,
                onSelect: () => setManual(true),
              },
            ]}
            renderTrigger={({ ref, toggle, open }) => (
              <button
                ref={ref}
                type="button"
                className="create-project__source-method"
                onClick={toggle}
                disabled={pending || picking}
                aria-expanded={open}
              >
                Add a folder from this machine
                <Icon name="chevron-down" size={13} />
              </button>
            )}
          />
          {manual ? (
            <div className="create-project__path">
              <input
                aria-label="Source folder path"
                placeholder="Full folder path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                disabled={picking || pending}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (path.trim()) void addFolder(path);
                  }
                }}
              />
              <button type="button" onClick={() => void addFolder(path)} disabled={!path.trim() || picking || pending}>
                Add
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="create-project__add"
              onClick={() => void addFolder()}
              disabled={picking || pending || folders.length >= 16}
            >
              <Icon name="folder-plus" size={15} />
              {picking ? 'Choosing…' : 'Add'}
            </button>
          )}
        </div>
        {folders.length > 1 ? (
          <p className="create-project__hint">Commands run in the first folder. The other folders also provide sources for the project.</p>
        ) : null}
        {error ? <Feedback tone="error">{error}</Feedback> : null}
        <footer className="create-project__footer">
          <button type="button" className="create-project__cancel" onClick={close} disabled={pending || picking}>
            Cancel
          </button>
          <button type="submit" className="create-project__submit" disabled={!name.trim() || !folders.length || pending || picking}>
            {pending ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save changes' : 'Create project'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
