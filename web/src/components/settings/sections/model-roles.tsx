/**
 * Which model each kind of run starts with: the default for new chats, then a
 * per-role assignment. An unset role says so plainly - it follows the default
 * chain, exactly as every conversation behaved before roles existed.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchModelRoles, setDefaultModelPair, setModelRole } from '../../../api.js';
import { Icon } from '../../icon.js';
import { Dropdown, type DropdownItem } from '../../selection/dropdown.js';
import type { ModelRolesInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';

const ROLES: ReadonlyArray<{ id: string; label: string; detail: string }> = [
  { id: 'agent', label: 'Chat', detail: 'Everyday conversations you open.' },
  { id: 'custodian', label: 'Custodian', detail: 'The head: machine stewardship and owner messages.' },
  { id: 'worker', label: 'Worker', detail: 'Delegated worker tasks, nested workers included.' },
  { id: 'background', label: 'Background', detail: 'Background tasks and schedule observers.' },
  { id: 'title', label: 'Title', detail: 'Chat naming; unset means the chat model names its own chats.' },
  { id: 'review', label: 'Reviewer', detail: 'The auto-review model judging risky calls; shared with the Approvals panel.' },
];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModelRolesSettings() {
  const [info, setInfo] = useState<ModelRolesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setInfo(await fetchModelRoles());
      setError(null);
    } catch (problem) {
      setError(describe(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultLabel =
    info?.default === null || info?.default === undefined
      ? 'From usage (most used)'
      : `${info.default.providerId} / ${info.default.modelId}${info.default.source === 'usage' ? ' (from usage)' : ''}`;

  const choose = async (role: string, providerId: string | null, modelId: string | null) => {
    if (busy) return;
    setBusy(role);
    setError(null);
    try {
      await setModelRole({ role, providerId, modelId });
      await load();
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(null);
    }
  };

  const chooseDefault = async (providerId: string | null, modelId: string | null) => {
    if (busy) return;
    setBusy('default');
    setError(null);
    try {
      await setDefaultModelPair({ providerId, modelId });
      await load();
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(null);
    }
  };

  const matches = (model: { providerId: string; modelId: string; name: string }) =>
    `${model.providerId} ${model.modelId} ${model.name}`.toLocaleLowerCase('en').includes(query.trim().toLocaleLowerCase('en'));

  const itemsFor = (
    value: { providerId: string; modelId: string } | null,
    fallbackLabel: string,
    pick: (providerId: string | null, modelId: string | null) => void,
  ): DropdownItem[] => [
    {
      id: '__default',
      label: fallbackLabel,
      description: value === null ? 'Active' : 'Follow the default chain',
      selected: value === null,
      onSelect: () => {
        setOpen(null);
        void pick(null, null);
      },
    },
    ...(info?.models ?? []).filter(matches).map((model) => ({
      id: `${model.providerId}/${model.modelId}`,
      label: model.name,
      description: `${model.providerId} / ${model.modelId}`,
      selected: value?.providerId === model.providerId && value?.modelId === model.modelId,
      onSelect: () => {
        setOpen(null);
        void pick(model.providerId, model.modelId);
      },
    })),
  ];

  const picker = (
    rowId: string,
    value: { providerId: string; modelId: string } | null,
    fallbackLabel: string,
    ariaLabel: string,
    pick: (providerId: string | null, modelId: string | null) => void,
  ) => (
    <Dropdown
      open={open === rowId}
      onOpenChange={(next) => {
        setOpen(next ? rowId : null);
        if (next) setQuery('');
      }}
      items={itemsFor(value, fallbackLabel, pick)}
      ariaLabel={ariaLabel}
      placement="bottom"
      align="end"
      itemSelectionMode="single"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Search models',
        ariaLabel: 'Search models',
      }}
      renderTrigger={({ ref, open: isOpen, toggle }) => (
        <button ref={ref} type="button" className="settings-picker" aria-expanded={isOpen} onClick={toggle}>
          <span className="settings-picker__value">{value ? value.modelId : fallbackLabel}</span>
          <Icon name="chevron-down" size={12} />
        </button>
      )}
    />
  );

  return (
    <SettingsPage title="Model roles" description="The default model, and a model per kind of run.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {info ? (
        <>
          <SettingsSection
            title="Default"
            description="What a new chat starts on. Without an explicit choice the most-used model wins automatically."
          >
            <SettingsGroup>
              <SettingsRow label="Default model" description={defaultLabel}>
                {picker('default', info.default, defaultLabel, 'Choose the default model', chooseDefault)}
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection title="Roles" description="Assign a provider and model to any role; unset roles follow the default.">
            <SettingsGroup>
              {ROLES.map((role) => {
                const value = info.roles[role.id] ?? null;
                const fallback = value ? `${value.modelId}` : `Default (${defaultLabel})`;
                return (
                  <SettingsRow
                    key={role.id}
                    label={role.label}
                    description={
                      value ? `${role.detail} Now: ${value.providerId} / ${value.modelId}.` : `${role.detail} Follows the default.`
                    }
                  >
                    {picker(
                      role.id,
                      value,
                      fallback,
                      `Choose the ${role.label} model`,
                      (providerId, modelId) => void choose(role.id, providerId, modelId),
                    )}
                  </SettingsRow>
                );
              })}
            </SettingsGroup>
          </SettingsSection>
        </>
      ) : null}
      {info === null && error === null ? <SettingsStatus tone="muted">Loading...</SettingsStatus> : null}
    </SettingsPage>
  );
}
