import type { SettingsSectionDef } from '../settings-page.js';
import { ModelsSettings } from './models.js';
import { ModelRolesSettings } from './model-roles.js';
import { ProvidersSettings } from './providers.js';
import { ModalSettings } from './modal.js';
import { UsageSettings } from './usage.js';
import { LogsSettings } from './logs.js';
import { AboutSettings } from './about.js';
import { TelegramSettings } from './telegram.js';
import { ApprovalsSettings } from './approvals.js';
import { MemorySettings } from './memory.js';
import { GeneralSettings } from './general.js';

/** Navigation, descriptions and sections share one authoritative registry. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'settings',
    group: 'General',
    description: 'Shell and machine defaults',
    render: () => <GeneralSettings />,
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: 'network',
    group: 'Intelligence',
    description: 'API endpoints and credentials',
    render: () => <ProvidersSettings />,
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'cpu',
    group: 'Intelligence',
    description: 'Available models and composer access',
    render: () => <ModelsSettings />,
  },
  {
    id: 'model-roles',
    label: 'Model roles',
    icon: 'cpu',
    group: 'Intelligence',
    description: 'Default model and per-role assignments',
    render: () => <ModelRolesSettings />,
  },
  {
    id: 'approvals',
    label: 'Approvals',
    icon: 'shield-check',
    group: 'Intelligence',
    description: 'Permissions and review policies',
    render: () => <ApprovalsSettings />,
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: 'brain',
    group: 'Intelligence',
    description: 'Knowledge and indexing',
    render: () => <MemorySettings />,
  },
  {
    id: 'modal',
    label: 'Modal',
    icon: 'cloud',
    group: 'Workspace',
    description: 'Remote compute credentials',
    render: () => <ModalSettings />,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    icon: 'send',
    group: 'Workspace',
    description: 'Messaging integration',
    render: () => <TelegramSettings />,
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'chart-no-axes-combined',
    group: 'System',
    description: 'Activity and cost analytics',
    render: () => <UsageSettings />,
  },
  { id: 'logs', label: 'Logs', icon: 'scroll-text', group: 'System', description: 'Runtime diagnostics', render: () => <LogsSettings /> },
  { id: 'about', label: 'About', icon: 'info', group: 'System', description: 'Version and environment', render: () => <AboutSettings /> },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.id;
