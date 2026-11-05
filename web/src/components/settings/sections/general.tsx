/** The defaults every session shares: which shell runs commands. */
import { useEffect, useState } from 'react';
import { fetchCommandShell, saveCommandShell } from '../../../api.js';
import type { CommandShellInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reader-facing names for the selectable presets; unknown values show as themselves. */
const SHELL_LABELS: Record<string, string> = {
  auto: 'Auto (latest available)',
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell 5',
  cmd: 'Command Prompt',
  'git-bash': 'Git Bash',
  wsl: 'WSL',
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
};

export function GeneralSettings() {
  const [info, setInfo] = useState<CommandShellInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCommandShell()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(describe(problem));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setInfo(await saveCommandShell(value));
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsPage title="General" description="Defaults that apply to every session on this machine.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {info?.error ? <SettingsStatus tone="error">{info.error}</SettingsStatus> : null}
      {info ? (
        <SettingsSection title="Shell" description="The shell the execute-command tool runs with.">
          <SettingsGroup>
            <SettingsRow label="Shell" description={`Detected right now: ${info.resolved ?? 'nothing available'}`}>
              <select
                className="settings-native-select"
                aria-label="Shell"
                value={info.value}
                disabled={saving}
                onChange={(event) => void change(event.target.value)}
              >
                {!info.options.includes(info.value) ? <option value={info.value}>{info.value}</option> : null}
                {info.options.map((option) => (
                  <option key={option} value={option}>
                    {SHELL_LABELS[option] ?? option}
                  </option>
                ))}
              </select>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      ) : null}
      {!info && !error ? <SettingsStatus>Loading…</SettingsStatus> : null}
    </SettingsPage>
  );
}
