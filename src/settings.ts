import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { getDataPath } from './paths.js';
import { commitSecrets, commitSettingsPair, withSettingsLock } from './settings-transaction.js';
import { isShellSettingValue, SHELL_PRESETS } from './tools/shell.js';

/**
 * Persisted configuration.
 *
 * Two files, two trust levels. `settings.yaml` holds everything the operator
 * may show, share, or let the agent edit: providers (without key material),
 * models, appearance, approval policy, schedules. `config.yaml` holds only secret
 * values — provider API keys — and is never shown to the agent. The runtime
 * shape (`SettingsStore`) is the union of the two, so every consumer keeps
 * working unchanged.
 *
 * Keys live in files rather than in the environment so the setup wizard has
 * something to edit; the environment still wins at resolve time for a
 * provider the catalog names no variable for.
 *
 * Both schemas are closed: an unknown key fails instead of being ignored. A
 * typo that silently fell back to a default is a bug that surfaces days later.
 */

export interface ProviderState {
  enabled: boolean;
  keys: string[];
  /** Model IDs the user has selected for this provider, including custom endpoints. */
  models?: string[];
  url?: string;
  npm?: string;
  /**
   * Raw options handed to the runtime package, applied last.
   *
   * OpenButler does not read these: they are whatever the package accepts, which is
   * how a provider that needs more than a key — an AWS region, a Google project,
   * an Azure resource name — becomes configurable without a code change here.
   */
  options?: Record<string, unknown>;
  /**
   * Native provider-routing preferences for a gateway provider, passed to the
   * gateway verbatim on every request.
   *
   * A gateway such as OpenRouter or Vercel AI Gateway load-balances one model
   * across many upstream providers, so the same model can be served by a
   * different backend each turn. These are the gateway's own routing fields
   * (for OpenRouter `order`, `only`, `allow_fallbacks`, `sort`, …; for the
   * Vercel gateway `order`, `only`, `sort`, …); OpenButler does not interpret
   * them, it only places them under the namespace the gateway expects.
   */
  routing?: Record<string, unknown>;
  /** Native routing per exact model ID; overrides provider-wide routing. */
  modelRouting?: Record<string, Record<string, unknown>>;
  /** Extra JSON fields merged into every request body this provider sends. */
  payload?: Record<string, unknown>;
  /** Facts about this provider's own models that the catalog does not carry. */
  modelSpecs?: Record<string, ProviderModelSpec>;
}

/** Settings-side description of one custom model: what the catalog would have said. */
export interface ProviderModelSpec {
  /** Readable display name; beats the catalog name when the operator sets it. */
  name?: string;
  /** Context window in tokens; the runtime falls back to this when the catalog has no entry. */
  context?: number;
  /** Output tokens the model accepts. */
  output?: number;
  /** Effort values the reasoning selector may offer for this model. */
  reasoning?: { efforts?: string[] };
  /** Extra JSON fields merged into requests for this model; overrides the provider payload. */
  payload?: Record<string, unknown>;
}

/** Select routing for this model without leaking another model's preferences. */
export function providerModelRouting(provider: ProviderState | undefined, modelId: string): Record<string, unknown> | undefined {
  return provider?.modelRouting?.[modelId] ?? provider?.routing;
}

/** MCP credentials are environment-variable names, never secret values. */
export type McpServerState =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface ScheduleState {
  id: string;
  name: string;
  enabled: boolean;
  workspaceRoot: string;
  /** Session that created the schedule; '' means no affinity (schedule-owned session). */
  originSessionId: string;
  instruction: string;
  trigger: { adapter: string; options: Record<string, unknown> };
}

export interface TelegramSettings {
  enabled: boolean;
  tokenEnv: string;
  workspaceRoot: string;
  chatId?: string;
  userId?: string;
}

/**
 * Non-secret team membership. Which team, who I am in it, where the hub
 * lives. The bearer ticket itself lives in config.yaml, never here.
 */
export interface TeamSettings {
  role: 'hub' | 'member';
  teamName: string;
  memberName: string;
  hubHost: string;
  hubPort: number;
  /** Hub fingerprint captured at join, so a rejoin can prove it is the same hub. */
  hubFingerprint?: string;
  /** The team's stable public id; keys shared memory and scopes local state. */
  teamId?: string;
}

export type ApprovalMode = 'workspace' | 'auto-review' | 'full-access';

export interface SettingsStore {
  providers: Record<string, ProviderState>;
  mcpServers: Record<string, McpServerState>;
  /** Try order for provider lookups. */
  providerOrder: string[];
  /**
   * The one model a run uses.
   *
   * A provider used to carry a model list where empty meant "every model the
   * catalog has". That was borrowed from a router, which tries models in turn.
   * OpenButler picks one model and uses it, so the list had no meaning: an empty
   * one read as "I added 44 models" when the operator had added none. One field,
   * one meaning.
   */
  defaultProvider: string;
  defaultModel: string;
  /**
   * Machine default reasoning variant id; a stale id resolves to the strongest
   * variant the model offers. Only a session without its own recorded effort
   * (SavedSession.reasoning) follows it - a chat the owner set keeps its own.
   */
  reasoning?: string;
  /** Reasoning deltas are shown in the session transcript unless explicitly switched off. */
  showReasoning?: boolean;
  /** TUI appearance: Dark, Light, or System (System follows the terminal background). */
  theme?: 'Dark' | 'Light' | 'System';
  /** Who decides actions that reach the explicit permission gate. */
  approvalMode: ApprovalMode;
  /**
   * How long an auto-review decision may take before it gives up and asks the
   * user. Slow or rate-limited providers need more than the built-in default;
   * too small a value turns every outside action into a manual prompt.
   */
  autoReviewTimeoutSeconds?: number;
  /**
   * Optional provider/model the permission reviewer runs on, so a flaky
   * reviewer can be swapped without changing the main model. Both must be
   * set together; unset means the reviewer reuses the main model.
   */
  autoReviewProvider?: string;
  autoReviewModel?: string;
  /**
   * Role-bound provider/model pairs; the canonical place every kind of run picks
   * its model (agent, custodian, worker, background, title, review). A role left
   * out falls back to the default chain - explicit default, then most-used.
   * Both fields of an entry must be set together, like autoReview: validation
   * happens at parse, so the rest of the system reads only whole pairs.
   */
  roles?: Record<string, { provider: string; model: string }>;
  /**
   * How long a manual approval prompt waits for a human decision before it
   * expires and the action is reported back to the model as unanswered. The
   * run keeps going: an expired approval is a timeout, never an approval.
   */
  approvalTimeoutSeconds?: number;
  /**
   * What execute_command launches. Unset or "auto" walks a fixed preference
   * order (PowerShell 7, then Windows PowerShell, then cmd on Windows; $SHELL,
   * then /bin/sh on POSIX). A preset — pwsh, powershell, cmd, git-bash, wsl,
   * bash, zsh, sh — or an executable path pins it explicitly.
   */
  commandShell?: string;
  /** Explicit schedules. An empty list starts no observers or scheduled model calls. */
  schedules: ScheduleState[];
  /** Workspace used by bare OpenButler launches; it does not define the machine custodian identity. */
  defaultWorkspaceRoot?: string;
  telegram?: TelegramSettings;
  /** Team membership; absent means this machine is not in a team. */
  team?: TeamSettings;
  /**
   * The machine custodian, configured by the owner and only by the owner. Every value
   * here is read at a named boundary (section 4.6) and none of them is ever written
   * onto a conversation: a setting that only exists as a field on a record can be
   * displayed nowhere and changed by nothing while it silently changes behaviour.
   */
  custodian?: CustodianSettings;
}

export interface CustodianSettings {
  /** Provider and model the head runs with; both must be set together. */
  provider?: string;
  model?: string;
  /** The head's compaction budget; clamped to the model window when it is used. */
  contextLimitTokens?: number;
  /** Whether a running turn is shown the bounded line naming reports that arrived. */
  reportLine?: boolean;
  /** Smallest gap between two turns the head starts on its own, in seconds. */
  reportTurnGapSeconds?: number;
  /** Running-worker limits: width per session, width per worker parent, and the machine total. */
  workerCaps?: { perSession: number; perWorkerParent: number; perMachine: number; depth: number };
}

export const CUSTODIAN_WORKER_CAP_DEFAULTS = { perSession: 8, perWorkerParent: 2, perMachine: 10, depth: 2 } as const;
export const CUSTODIAN_CONTEXT_LIMIT_RANGE = { min: 10_000, max: 2_000_000 } as const;
export const CUSTODIAN_REPORT_GAP_RANGE = { min: 0, max: 3_600 } as const;

const SETTINGS_FILE = getDataPath('settings.yaml');
const CONFIG_FILE = getDataPath('config.yaml');
const loadedRevisions = new WeakMap<SettingsStore, string>();

function diskSettingsRevision(): string {
  const hash = createHash('sha256');
  try {
    hash.update('settings:').update(readFileSync(SETTINGS_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update('settings:missing');
  }
  // A separate owner can rotate a team ticket or Modal token without editing
  // model settings. Saving settings merges those secrets from disk, so only
  // provider keys (which the SettingsStore actually rewrites) participate in
  // optimistic concurrency control.
  const providers = loadSecretsUnlocked().providers;
  hash.update(JSON.stringify(Object.entries(providers).sort(([a], [b]) => a.localeCompare(b))));
  return hash.digest('hex');
}

const KNOWN_KEYS = new Set([
  'providers',
  'mcpServers',
  'providerOrder',
  'defaultProvider',
  'defaultModel',
  'reasoning',
  'showReasoning',
  'theme',
  'approvalMode',
  'autoReviewTimeoutSeconds',
  'autoReviewProvider',
  'autoReviewModel',
  'roles',
  'approvalTimeoutSeconds',
  'commandShell',
  'schedules',
  'backgroundTasks',
  'defaultWorkspaceRoot',
  'telegram',
  'team',
  'custodian',
]);
const KNOWN_PROVIDER_KEYS = new Set([
  'enabled',
  'keys',
  'models',
  'url',
  'npm',
  'options',
  'routing',
  'modelRouting',
  'payload',
  'modelSpecs',
]);

/**
 * Rebuilds a provider state from an existing one plus a patch, carrying every
 * field the schema knows about.
 *
 * Callers used to enumerate the fields by hand, and a field left out of that
 * list was wiped the next time the provider was saved: a gateway's `routing`
 * pin disappeared after re-entering a key, and the gateway silently went back
 * to load-balancing across every upstream. Iterating the schema set instead
 * means a new provider field is carried automatically, and adding it still
 * requires touching this one set that also validates settings.yaml.
 *
 * `keys` is the exception: it is never taken from the existing state unless the
 * patch omits it, so a caller cannot be tricked into resurrecting a removed key.
 */
export function withProviderFields(existing: ProviderState | undefined, patch: Partial<ProviderState> = {}): ProviderState {
  const next: Record<string, unknown> = {
    enabled: existing?.enabled ?? true,
    keys: [...(patch.keys ?? existing?.keys ?? [])],
  };
  const previous = existing as unknown as Record<string, unknown> | undefined;
  const incoming = patch as unknown as Record<string, unknown>;
  for (const key of KNOWN_PROVIDER_KEYS) {
    if (key === 'keys') continue;
    const value = key in incoming ? incoming[key] : previous?.[key];
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as ProviderState;
}

/**
 * The secret half of the persisted configuration: provider API keys plus the
 * team bearer ticket, nothing else. The host reads this file directly; it is
 * never handed to the agent.
 */
export interface ProviderSecrets {
  keys: string[];
}

export interface SecretsStore {
  providers: Record<string, ProviderSecrets>;
  /** Raw team bearer ticket; absent when this machine is not a joined member. */
  teamTicket?: string;
  /** Modal control-plane credentials, used to provision GPU work on the owner's behalf. */
  modal?: ModalCredentials;
}

export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

const KNOWN_SECRET_KEYS = new Set(['providers', 'teamTicket', 'modal']);
const KNOWN_PROVIDER_SECRET_KEYS = new Set(['keys']);

function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Maps names exposed to an MCP server to host environment-variable names. */
function environmentReferences(
  value: unknown,
  where: string,
  isTargetName: (value: string) => boolean = isEnvironmentName,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${where} must map names to environment-variable names`);
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(value)) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !isTargetName(key) ||
      typeof reference !== 'string' ||
      !isEnvironmentName(reference)
    ) {
      throw new Error(`${where}.${key} must name a host environment variable`);
    }
    result[key] = reference;
  }
  return result;
}

export function parseMcpServerState(raw: unknown, id: string): McpServerState {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,58}$/.test(id)) throw new Error(`mcpServers.${id} has an invalid server id`);
  if (!isRecord(raw)) throw new Error(`mcpServers.${id} must be a mapping`);
  if (raw.transport === 'stdio') {
    const allowed = new Set(['transport', 'command', 'args', 'env', 'cwd']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`mcpServers.${id}.${key} is not a stdio setting`);
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      throw new Error(`mcpServers.${id}.command must be a non-empty executable name`);
    }
    const server: McpServerState = {
      transport: 'stdio',
      command: raw.command,
      args: stringArray(raw.args, `mcpServers.${id}.args`),
      env: environmentReferences(raw.env, `mcpServers.${id}.env`),
    };
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) throw new Error(`mcpServers.${id}.cwd must be a non-empty path`);
      server.cwd = raw.cwd;
    }
    return server;
  }

  if (raw.transport === 'http' || raw.transport === 'sse') {
    const allowed = new Set(['transport', 'url', 'headers']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`mcpServers.${id}.${key} is not an HTTP setting`);
    if (typeof raw.url !== 'string') throw new Error(`mcpServers.${id}.url must be a URL`);
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw new Error(`mcpServers.${id}.url must be a valid HTTP or HTTPS URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`mcpServers.${id}.url must use HTTP(S) and must not contain credentials`);
    }
    return {
      transport: raw.transport,
      url: url.toString(),
      headers: environmentReferences(raw.headers, `mcpServers.${id}.headers`, (name) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)),
    };
  }

  throw new Error(`mcpServers.${id}.transport must be stdio, http, or sse`);
}

export function getSettingsPath(): string {
  return SETTINGS_FILE;
}

/** The secret half of the persisted configuration; never shown to the agent. */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where} must be a list of strings`);
  }
  return value as string[];
}

/**
 * Validates the raw option bag handed to a provider's runtime package.
 *
 * The values are not OpenButler's to interpret, but they are OpenButler's to refuse when
 * malformed: a mapping of bounded size, with no prototype keys, because these
 * objects reach `import()` arguments and request headers.
 */
function providerOptions(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be a mapping of option names to values`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_000) throw new Error(`${where} must serialize under 16000 characters (got ${serialized.length}).`);
  const clone = (node: Record<string, unknown>, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error(`${path}.${key} is not an allowed option name.`);
      }
      if (item !== null && typeof item === 'object' && !Array.isArray(item))
        out[key] = clone(item as Record<string, unknown>, `${path}.${key}`);
      else if (Array.isArray(item))
        out[key] = item.map((entry) => (typeof entry === 'object' && entry !== null ? JSON.parse(JSON.stringify(entry)) : entry));
      else out[key] = item;
    }
    return out;
  };
  return clone(value, where);
}

function parseProviderState(raw: unknown, id: string): ProviderState {
  if (!isRecord(raw)) throw new Error(`providers.${id} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROVIDER_KEYS.has(key)) {
      throw new Error(`providers.${id}.${key} is not a setting openbutler knows (known: ${[...KNOWN_PROVIDER_KEYS].join(', ')})`);
    }
  }
  const state: ProviderState = {
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    keys: stringArray(raw.keys, `providers.${id}.keys`),
  };
  if (raw.models !== undefined) {
    const models = stringArray(raw.models, `providers.${id}.models`);
    if (models.length > 512 || models.some((model) => !model.trim() || model.length > 512)) {
      throw new Error(`providers.${id}.models must contain at most 512 non-empty model IDs under 512 characters each.`);
    }
    state.models = [...new Set(models.map((model) => model.trim()))];
  }
  if (typeof raw.url === 'string' && raw.url.length > 0) state.url = raw.url;
  if (typeof raw.npm === 'string' && raw.npm.length > 0) state.npm = raw.npm;
  if (raw.options !== undefined) {
    const options = providerOptions(raw.options, `providers.${id}.options`);
    if (Object.keys(options).length > 0) state.options = options;
  }
  if (raw.routing !== undefined) {
    const routing = providerOptions(raw.routing, `providers.${id}.routing`);
    if (Object.keys(routing).length > 0) state.routing = routing;
  }
  if (raw.modelRouting !== undefined) {
    const entries = providerOptions(raw.modelRouting, `providers.${id}.modelRouting`);
    const modelRouting: Record<string, Record<string, unknown>> = {};
    for (const [modelId, routing] of Object.entries(entries)) {
      if (!modelId.trim() || modelId.length > 512)
        throw new Error(`providers.${id}.modelRouting requires non-empty model IDs under 512 characters.`);
      modelRouting[modelId] = providerOptions(routing, `providers.${id}.modelRouting.${modelId}`);
    }
    state.modelRouting = modelRouting;
  }
  if (raw.payload !== undefined) {
    const payload = providerOptions(raw.payload, `providers.${id}.payload`);
    if (Object.keys(payload).length > 0) state.payload = payload;
  }
  if (raw.modelSpecs !== undefined) {
    if (!isRecord(raw.modelSpecs)) throw new Error(`providers.${id}.modelSpecs must be a mapping`);
    const specs: Record<string, ProviderModelSpec> = {};
    const specKeys = ['name', 'context', 'output', 'reasoning', 'payload'];
    for (const [modelId, rawSpec] of Object.entries(raw.modelSpecs)) {
      if (!modelId.trim() || modelId.length > 512)
        throw new Error(`providers.${id}.modelSpecs requires non-empty model IDs under 512 characters.`);
      if (!isRecord(rawSpec)) throw new Error(`providers.${id}.modelSpecs.${modelId} must be a mapping`);
      for (const key of Object.keys(rawSpec)) {
        if (!specKeys.includes(key))
          throw new Error(
            `providers.${id}.modelSpecs.${modelId}.${key} is not a model spec openbutler knows (known: ${specKeys.join(', ')})`,
          );
      }
      const spec: ProviderModelSpec = {};
      if (rawSpec.name !== undefined) {
        if (typeof rawSpec.name !== 'string' || !rawSpec.name.trim() || rawSpec.name.length > 128)
          throw new Error(`providers.${id}.modelSpecs.${modelId}.name must use 1-128 characters.`);
        spec.name = rawSpec.name.trim();
      }
      for (const key of ['context', 'output'] as const) {
        const value = rawSpec[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
          throw new Error(`providers.${id}.modelSpecs.${modelId}.${key} must be a positive whole number of tokens.`);
        spec[key] = value;
      }
      if (rawSpec.reasoning !== undefined) {
        if (!isRecord(rawSpec.reasoning)) throw new Error(`providers.${id}.modelSpecs.${modelId}.reasoning must be a mapping`);
        const efforts = stringArray(rawSpec.reasoning.efforts, `providers.${id}.modelSpecs.${modelId}.reasoning.efforts`)
          .map((value) => value.trim())
          .filter(Boolean);
        if (efforts.length > 0) spec.reasoning = { efforts: [...new Set(efforts)] };
      }
      if (rawSpec.payload !== undefined) {
        const payload = providerOptions(rawSpec.payload, `providers.${id}.modelSpecs.${modelId}.payload`);
        if (Object.keys(payload).length > 0) spec.payload = payload;
      }
      specs[modelId] = spec;
    }
    if (Object.keys(specs).length > 0) state.modelSpecs = specs;
  }
  return state;
}

/**
 * True when something authenticates this provider.
 *
 * A key is the usual answer, but not the only one: a provider whose runtime
 * package signs requests itself (AWS SigV4) or reads a service account from the
 * environment (Google Vertex) needs no key, and the operator declares that by
 * giving the provider an `options` block. Without options and without a key the
 * provider is genuinely unconfigured.
 */
export function hasCredential(state: ProviderState | undefined): boolean {
  if (!state) return false;
  return state.keys.length > 0 || Object.keys(state.options ?? {}).length > 0;
}

/** Retains a model as a provider-specific choice without making it the default. */
export function rememberProviderModel(settings: SettingsStore, providerId: string, modelId: string): void {
  const provider = settings.providers[providerId];
  const normalized = modelId.trim();
  if (!provider || !normalized || provider.models?.includes(normalized)) return;
  if ((provider.models?.length ?? 0) >= 512) throw new Error(`Provider ${providerId} already has 512 saved model IDs.`);
  provider.models = [...(provider.models ?? []), normalized];
}

/** Creates or extends one provider entry; the schema owns the field list (withProviderFields). */
export function upsertProvider(settings: SettingsStore, id: string, patch: Partial<ProviderState>): ProviderState {
  const next = withProviderFields(settings.providers[id], patch);
  settings.providers[id] = next;
  if (!settings.providerOrder.includes(id)) settings.providerOrder.push(id);
  return next;
}

/**
 * Removes a provider's settings entry, its order slot, and a default that named
 * it. The next save rebuilds the secret store without it, so its keys go too:
 * removing a provider removes its credentials with it.
 */
export function removeProvider(settings: SettingsStore, id: string): boolean {
  if (!(id in settings.providers)) return false;
  delete settings.providers[id];
  settings.providerOrder = settings.providerOrder.filter((entry) => entry !== id);
  if (settings.defaultProvider === id) {
    settings.defaultProvider = '';
    settings.defaultModel = '';
  }
  // A role bound to the removed provider cannot resolve to anything meaningful,
  // so it goes the way of the default: cleared rather than left dangling.
  if (settings.roles) {
    const kept = Object.fromEntries(Object.entries(settings.roles).filter(([, entry]) => entry.provider !== id));
    if (Object.keys(kept).length > 0) settings.roles = kept;
    else delete settings.roles;
  }
  return true;
}

export function defaultSettings(): SettingsStore {
  return {
    providers: {},
    mcpServers: {},
    providerOrder: [],
    defaultProvider: '',
    defaultModel: '',
    approvalMode: 'workspace',
    schedules: [],
  };
}

/** Reads settings from disk, or returns defaults when the file is absent. */
export function loadSettings(): SettingsStore {
  return withSettingsLock(() => {
    const settings = loadSettingsUnlocked();
    loadedRevisions.set(settings, diskSettingsRevision());
    return settings;
  });
}

function loadSettingsUnlocked(): SettingsStore {
  let text: string;
  try {
    text = readFileSync(SETTINGS_FILE, 'utf8');
  } catch (error) {
    // Only a missing file means "defaults". A permissions or I/O failure must stay visible.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No settings file still leaves the secret store: keys without settings
      // are a configured provider, not an empty one.
      const settings = defaultSettings();
      mergeSecrets(settings, loadSecrets());
      return settings;
    }
    throw error;
  }
  const parsed: unknown = parseYaml(text);
  if (parsed === null || parsed === undefined) return defaultSettings();
  if (!isRecord(parsed)) throw new Error(`${SETTINGS_FILE} must be a mapping`);
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`${key} is not a setting openbutler knows (known: ${[...KNOWN_KEYS].join(', ')})`);
    }
  }

  const settings = defaultSettings();
  if (isRecord(parsed.providers)) {
    for (const [id, raw] of Object.entries(parsed.providers)) settings.providers[id] = parseProviderState(raw, id);
  }
  if (parsed.mcpServers !== undefined) {
    if (!isRecord(parsed.mcpServers)) throw new Error('mcpServers must be a mapping');
    for (const [id, raw] of Object.entries(parsed.mcpServers)) {
      settings.mcpServers[id] = parseMcpServerState(raw, id);
    }
  }
  settings.providerOrder = stringArray(parsed.providerOrder, 'providerOrder').filter((id) => id in settings.providers);
  for (const id of Object.keys(settings.providers)) {
    if (!settings.providerOrder.includes(id)) settings.providerOrder.push(id);
  }
  if (typeof parsed.defaultProvider === 'string') settings.defaultProvider = parsed.defaultProvider;
  if (typeof parsed.defaultModel === 'string') settings.defaultModel = parsed.defaultModel;
  if (parsed.reasoning !== undefined) {
    if (typeof parsed.reasoning !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(parsed.reasoning)) {
      throw new Error('reasoning must be a valid model variant id');
    }
    settings.reasoning = parsed.reasoning;
  }
  if (parsed.showReasoning !== undefined) {
    if (typeof parsed.showReasoning !== 'boolean') throw new Error('showReasoning must be a boolean');
    settings.showReasoning = parsed.showReasoning;
  }
  if (parsed.theme !== undefined) {
    if (parsed.theme !== 'Dark' && parsed.theme !== 'Light' && parsed.theme !== 'System') {
      throw new Error('theme must be Dark, Light, or System');
    }
    settings.theme = parsed.theme;
  }
  if (parsed.commandShell !== undefined) {
    const shell = typeof parsed.commandShell === 'string' ? parsed.commandShell.trim() : '';
    if (!isShellSettingValue(shell)) {
      throw new Error(`commandShell must be one of ${SHELL_PRESETS.join(', ')} or an executable path`);
    }
    settings.commandShell = shell;
  }
  if (parsed.approvalMode !== undefined) {
    if (parsed.approvalMode === 'ask') {
      // Migrate the original v1 approval mode to the folder-scoped default.
      settings.approvalMode = 'workspace';
    } else if (parsed.approvalMode === 'workspace' || parsed.approvalMode === 'auto-review' || parsed.approvalMode === 'full-access') {
      settings.approvalMode = parsed.approvalMode;
    } else throw new Error('approvalMode must be workspace, auto-review, or full-access');
  }
  if (parsed.autoReviewTimeoutSeconds !== undefined) {
    if (
      typeof parsed.autoReviewTimeoutSeconds !== 'number' ||
      !Number.isInteger(parsed.autoReviewTimeoutSeconds) ||
      parsed.autoReviewTimeoutSeconds < 5 ||
      parsed.autoReviewTimeoutSeconds > 600
    ) {
      throw new Error('autoReviewTimeoutSeconds must be a whole number of seconds between 5 and 600.');
    }
    settings.autoReviewTimeoutSeconds = parsed.autoReviewTimeoutSeconds;
  }
  if (parsed.autoReviewProvider !== undefined || parsed.autoReviewModel !== undefined) {
    const provider = parsed.autoReviewProvider;
    const model = parsed.autoReviewModel;
    if (provider === undefined && model === undefined) {
      // Both omitted: nothing to do.
    } else if (provider === null || model === null) {
      delete settings.autoReviewProvider;
      delete settings.autoReviewModel;
    } else if (typeof provider !== 'string' || typeof model !== 'string' || !provider.trim() || !model.trim()) {
      throw new Error('autoReviewProvider and autoReviewModel must both be non-empty strings, or both omitted.');
    } else {
      settings.autoReviewProvider = provider.trim();
      settings.autoReviewModel = model.trim();
    }
  }
  if (parsed.roles !== undefined) {
    if (parsed.roles === null) {
      delete settings.roles;
    } else if (!isRecord(parsed.roles)) {
      throw new Error('roles must be a mapping of role name to a { provider, model } pair.');
    } else {
      const roles: Record<string, { provider: string; model: string }> = {};
      for (const [role, raw] of Object.entries(parsed.roles)) {
        if (raw === null || raw === undefined) continue;
        if (!isRecord(raw)) throw new Error(`roles.${role} must be a { provider, model } pair.`);
        const { provider, model } = raw;
        if ((provider === null || provider === undefined) && (model === null || model === undefined)) continue;
        if (typeof provider !== 'string' || typeof model !== 'string' || !provider.trim() || !model.trim()) {
          throw new Error(`roles.${role}.provider and roles.${role}.model must both be non-empty strings, or the role must be omitted.`);
        }
        roles[role] = { provider: provider.trim(), model: model.trim() };
      }
      if (Object.keys(roles).length > 0) settings.roles = roles;
      else delete settings.roles;
    }
  }
  if (parsed.approvalTimeoutSeconds !== undefined) {
    if (
      typeof parsed.approvalTimeoutSeconds !== 'number' ||
      !Number.isInteger(parsed.approvalTimeoutSeconds) ||
      parsed.approvalTimeoutSeconds < 5 ||
      parsed.approvalTimeoutSeconds > 600
    ) {
      throw new Error('approvalTimeoutSeconds must be a whole number of seconds between 5 and 600.');
    }
    settings.approvalTimeoutSeconds = parsed.approvalTimeoutSeconds;
  }
  // `backgroundTasks` is the pre-rename key; read it once so an older settings.yaml still loads.
  const parsedSchedules = parsed.schedules ?? parsed.backgroundTasks;
  if (parsedSchedules !== undefined) {
    if (!Array.isArray(parsedSchedules) || parsedSchedules.length > 256)
      throw new Error('schedules must be a list of up to 256 schedules.');
    settings.schedules = parsedSchedules.map(parseScheduleState);
    if (new Set(settings.schedules.map((schedule) => schedule.id)).size !== settings.schedules.length)
      throw new Error('schedules contains duplicate schedule ids.');
  }
  if (parsed.defaultWorkspaceRoot !== undefined) {
    if (
      typeof parsed.defaultWorkspaceRoot !== 'string' ||
      parsed.defaultWorkspaceRoot.length > 32_768 ||
      !isAbsolute(parsed.defaultWorkspaceRoot)
    )
      throw new Error('defaultWorkspaceRoot must be an absolute path.');
    settings.defaultWorkspaceRoot = parsed.defaultWorkspaceRoot;
  }
  if (parsed.telegram !== undefined) settings.telegram = parseTelegramSettings(parsed.telegram);
  if (parsed.team !== undefined) settings.team = parseTeamSettings(parsed.team);
  if (parsed.custodian !== undefined) settings.custodian = parseCustodianSettings(parsed.custodian);
  // Ingest the single-purpose fields written before roles existed: a reviewer
  // or custodian pair read the old way becomes a role entry right here, so from
  // parse on there is one place every reader consults. The legacy fields stay
  // in the document for compatibility; nothing clears them.
  if (!settings.roles?.review && settings.autoReviewProvider && settings.autoReviewModel) {
    settings.roles = { ...settings.roles, review: { provider: settings.autoReviewProvider, model: settings.autoReviewModel } };
  }
  if (!settings.roles?.custodian && settings.custodian?.provider && settings.custodian?.model) {
    settings.roles = { ...settings.roles, custodian: { provider: settings.custodian.provider, model: settings.custodian.model } };
  }
  mergeSecrets(settings, loadSecrets());
  return settings;
}

const CUSTODIAN_KEYS = new Set(['provider', 'model', 'contextLimitTokens', 'reportLine', 'reportTurnGapSeconds', 'workerCaps']);
const CUSTODIAN_WORKER_CAP_KEYS = new Set(['perSession', 'perWorkerParent', 'perMachine', 'depth']);

function wholeNumberInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

/**
 * The head's settings, validated where they are read. A wrong value is refused by
 * name and range instead of silently becoming the default: an owner who typed 0 for
 * the gap must be told that 0 is allowed but 4000 is not, not quietly given 60.
 */
export function parseCustodianSettings(raw: unknown): CustodianSettings {
  if (!isRecord(raw)) throw new Error('custodian must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!CUSTODIAN_KEYS.has(key)) {
      throw new Error(`custodian.${key} is not a setting openbutler knows (known: ${[...CUSTODIAN_KEYS].join(', ')})`);
    }
  }
  const settings: CustodianSettings = {};
  const provider = raw.provider;
  const model = raw.model;
  if (provider !== undefined || model !== undefined) {
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider.trim() || !model.trim()) {
      throw new Error('custodian.provider and custodian.model must both be non-empty strings, or both omitted.');
    }
    settings.provider = provider.trim();
    settings.model = model.trim();
  }
  if (raw.contextLimitTokens !== undefined) {
    settings.contextLimitTokens = wholeNumberInRange(
      raw.contextLimitTokens,
      'custodian.contextLimitTokens',
      CUSTODIAN_CONTEXT_LIMIT_RANGE.min,
      CUSTODIAN_CONTEXT_LIMIT_RANGE.max,
    );
  }
  if (raw.reportLine !== undefined) {
    if (typeof raw.reportLine !== 'boolean') throw new Error('custodian.reportLine must be true or false.');
    settings.reportLine = raw.reportLine;
  }
  if (raw.reportTurnGapSeconds !== undefined) {
    settings.reportTurnGapSeconds = wholeNumberInRange(
      raw.reportTurnGapSeconds,
      'custodian.reportTurnGapSeconds',
      CUSTODIAN_REPORT_GAP_RANGE.min,
      CUSTODIAN_REPORT_GAP_RANGE.max,
    );
  }
  if (raw.workerCaps !== undefined) {
    if (!isRecord(raw.workerCaps)) throw new Error('custodian.workerCaps must be a mapping');
    for (const key of Object.keys(raw.workerCaps)) {
      if (!CUSTODIAN_WORKER_CAP_KEYS.has(key)) {
        throw new Error(
          `custodian.workerCaps.${key} is not a setting openbutler knows (known: ${[...CUSTODIAN_WORKER_CAP_KEYS].join(', ')})`,
        );
      }
    }
    const caps = raw.workerCaps;
    settings.workerCaps = {
      perSession: wholeNumberInRange(caps.perSession ?? CUSTODIAN_WORKER_CAP_DEFAULTS.perSession, 'custodian.workerCaps.perSession', 1, 32),
      perWorkerParent: wholeNumberInRange(
        caps.perWorkerParent ?? CUSTODIAN_WORKER_CAP_DEFAULTS.perWorkerParent,
        'custodian.workerCaps.perWorkerParent',
        0,
        8,
      ),
      perMachine: wholeNumberInRange(caps.perMachine ?? CUSTODIAN_WORKER_CAP_DEFAULTS.perMachine, 'custodian.workerCaps.perMachine', 1, 64),
      depth: wholeNumberInRange(caps.depth ?? CUSTODIAN_WORKER_CAP_DEFAULTS.depth, 'custodian.workerCaps.depth', 1, 3),
    };
  }
  return settings;
}

export function parseTeamSettings(raw: unknown): TeamSettings {
  if (!isRecord(raw)) throw new Error('team must be a mapping.');
  const allowed = new Set(['role', 'teamName', 'memberName', 'hubHost', 'hubPort', 'hubFingerprint', 'teamId']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`team.${key} is not a supported setting.`);
  if (raw.role !== 'hub' && raw.role !== 'member') throw new Error('team.role must be hub or member.');
  if (typeof raw.teamName !== 'string' || !raw.teamName.trim() || raw.teamName.length > 64)
    throw new Error('team.teamName must be 1-64 characters.');
  if (typeof raw.memberName !== 'string' || !raw.memberName.trim() || raw.memberName.length > 64)
    throw new Error('team.memberName must be 1-64 characters.');
  if (typeof raw.hubHost !== 'string' || !raw.hubHost.trim() || raw.hubHost.length > 512)
    throw new Error('team.hubHost must be a non-empty host under 512 characters.');
  if (typeof raw.hubPort !== 'number' || !Number.isInteger(raw.hubPort) || raw.hubPort < 1 || raw.hubPort > 65535)
    throw new Error('team.hubPort must be a port 1-65535.');
  if (raw.hubFingerprint !== undefined && (typeof raw.hubFingerprint !== 'string' || raw.hubFingerprint.length > 64))
    throw new Error('team.hubFingerprint must be a short string.');
  if (raw.teamId !== undefined && (typeof raw.teamId !== 'string' || raw.teamId.length > 64))
    throw new Error('team.teamId must be a short string.');
  return {
    role: raw.role,
    teamName: raw.teamName,
    memberName: raw.memberName,
    hubHost: raw.hubHost,
    hubPort: raw.hubPort,
    ...(raw.hubFingerprint === undefined ? {} : { hubFingerprint: raw.hubFingerprint as string }),
    ...(raw.teamId === undefined ? {} : { teamId: raw.teamId as string }),
  };
}

/**
 * Folds the secret store into the loaded settings. Files written before the
 * split still carry `keys` inside settings.yaml; those keep working and move
 * to config.yaml on the next save. When both files name keys for one
 * provider the lists unite, so a hand edit on either side never loses a key.
 * A provider named only by the secret store is created enabled, and joins
 * the provider order so it stays reachable.
 */
function mergeSecrets(settings: SettingsStore, secrets: SecretsStore): void {
  for (const [id, secret] of Object.entries(secrets.providers)) {
    const existing = settings.providers[id];
    if (existing) {
      const merged = [...secret.keys];
      for (const key of existing.keys) if (!merged.includes(key)) merged.push(key);
      existing.keys = merged;
    } else {
      settings.providers[id] = { enabled: true, keys: [...secret.keys] };
    }
    if (!settings.providerOrder.includes(id)) settings.providerOrder.push(id);
  }
}

/** Reads the secret store from disk, or empty when the file is absent. */
export function loadSecrets(): SecretsStore {
  return withSettingsLock(loadSecretsUnlocked);
}

function loadSecretsUnlocked(): SecretsStore {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    // Only a missing file means "no secrets". A permissions or I/O failure must stay visible.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {} };
    throw error;
  }
  const parsed: unknown = parseYaml(text);
  if (parsed === null || parsed === undefined) return { providers: {} };
  if (!isRecord(parsed)) throw new Error(`${CONFIG_FILE} must be a mapping`);
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_SECRET_KEYS.has(key)) {
      throw new Error(`${key} is not a secret openbutler knows (known: ${[...KNOWN_SECRET_KEYS].join(', ')})`);
    }
  }
  const secrets: SecretsStore = { providers: {} };
  if (isRecord(parsed.providers)) {
    for (const [id, raw] of Object.entries(parsed.providers)) secrets.providers[id] = parseProviderSecrets(raw, id);
  }
  if (parsed.teamTicket !== undefined) {
    if (typeof parsed.teamTicket !== 'string' || !parsed.teamTicket || parsed.teamTicket.length > 512)
      throw new Error('config teamTicket must be a non-empty string under 512 characters.');
    secrets.teamTicket = parsed.teamTicket;
  }
  if (parsed.modal !== undefined) secrets.modal = parseModalSecrets(parsed.modal);
  return secrets;
}

function parseModalSecrets(raw: unknown): ModalCredentials {
  if (!isRecord(raw)) throw new Error('config modal must be a mapping');
  for (const key of Object.keys(raw)) {
    if (key !== 'tokenId' && key !== 'tokenSecret') throw new Error(`config modal.${key} is not a secret openbutler knows`);
  }
  const tokenId = raw.tokenId;
  const tokenSecret = raw.tokenSecret;
  if (typeof tokenId !== 'string' || !tokenId || tokenId.length > 256) throw new Error('config modal.tokenId must be a non-empty string.');
  if (typeof tokenSecret !== 'string' || !tokenSecret || tokenSecret.length > 512)
    throw new Error('config modal.tokenSecret must be a non-empty string.');
  return { tokenId, tokenSecret };
}

function parseProviderSecrets(raw: unknown, id: string): ProviderSecrets {
  if (!isRecord(raw)) throw new Error(`config providers.${id} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROVIDER_SECRET_KEYS.has(key)) {
      throw new Error(
        `config providers.${id}.${key} is not a secret openbutler knows (known: ${[...KNOWN_PROVIDER_SECRET_KEYS].join(', ')})`,
      );
    }
  }
  return { keys: stringArray(raw.keys, `config providers.${id}.keys`) };
}

/** Stable YAML serialization shared by the journaled pair and single-file writes. */
function serializeYaml(document: unknown): string {
  return dumpYaml(document, { lineWidth: 120 });
}

/**
 * Writes the whole secret store. Prefer saveSettings for settings changes;
 * use this for ticket-only updates so callers never touch provider keys.
 */
export function saveSecrets(secrets: SecretsStore): void {
  const providers: Record<string, ProviderSecrets> = {};
  for (const [id, secret] of Object.entries(secrets.providers)) providers[id] = { keys: [...secret.keys] };
  commitSecrets(
    serializeYaml({
      providers,
      ...(secrets.teamTicket ? { teamTicket: secrets.teamTicket } : {}),
      ...(secrets.modal ? { modal: { tokenId: secrets.modal.tokenId, tokenSecret: secrets.modal.tokenSecret } } : {}),
    }),
  );
}

/** Modal credentials, or null when this machine has none. */
export function loadModalCredentials(): ModalCredentials | null {
  return loadSecrets().modal ?? null;
}

/** Stores Modal credentials, keeping provider keys and the team ticket intact. */
export function saveModalCredentials(credentials: ModalCredentials): void {
  const secrets = loadSecrets();
  secrets.modal = { tokenId: credentials.tokenId, tokenSecret: credentials.tokenSecret };
  saveSecrets(secrets);
}

/** Removes Modal credentials. */
export function clearModalCredentials(): void {
  const secrets = loadSecrets();
  delete secrets.modal;
  saveSecrets(secrets);
}

/**
 * Writes settings atomically. Key material goes to config.yaml; everything
 * else goes to settings.yaml, so a pre-split file is cleaned the first time
 * it is saved.
 */
export function saveSettings(settings: SettingsStore): void {
  withSettingsLock(() => {
    const expected = loadedRevisions.get(settings);
    if (expected !== undefined && expected !== diskSettingsRevision()) {
      throw new Error('Settings changed after this copy was loaded. Reload settings before saving to avoid overwriting another writer.');
    }
    saveSettingsUnlocked(settings);
    loadedRevisions.set(settings, diskSettingsRevision());
  });
}

function saveSettingsUnlocked(settings: SettingsStore): void {
  const ordered: Record<string, ProviderState> = {};
  for (const id of [...settings.providerOrder, ...Object.keys(settings.providers)]) {
    if (id in settings.providers) ordered[id] = settings.providers[id];
  }
  const settingsProviders: Record<string, Omit<ProviderState, 'keys'>> = {};
  const secretProviders: Record<string, ProviderSecrets> = {};
  for (const [id, provider] of Object.entries(ordered)) {
    const { keys, ...rest } = provider;
    settingsProviders[id] = rest;
    if (keys.length > 0) secretProviders[id] = { keys: [...keys] };
  }
  const document = {
    providers: settingsProviders,
    mcpServers: settings.mcpServers,
    providerOrder: Object.keys(ordered),
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
    ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
    ...(settings.showReasoning !== undefined ? { showReasoning: settings.showReasoning } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
    approvalMode: settings.approvalMode,
    ...(settings.autoReviewTimeoutSeconds === undefined ? {} : { autoReviewTimeoutSeconds: settings.autoReviewTimeoutSeconds }),
    ...(settings.autoReviewProvider === undefined ? {} : { autoReviewProvider: settings.autoReviewProvider }),
    ...(settings.autoReviewModel === undefined ? {} : { autoReviewModel: settings.autoReviewModel }),
    ...(settings.roles === undefined ? {} : { roles: settings.roles }),
    ...(settings.approvalTimeoutSeconds === undefined ? {} : { approvalTimeoutSeconds: settings.approvalTimeoutSeconds }),
    ...(settings.commandShell === undefined ? {} : { commandShell: settings.commandShell }),
    schedules: settings.schedules,
    ...(settings.defaultWorkspaceRoot ? { defaultWorkspaceRoot: settings.defaultWorkspaceRoot } : {}),
    ...(settings.telegram ? { telegram: settings.telegram } : {}),
    ...(settings.team ? { team: settings.team } : {}),
    ...(settings.custodian ? { custodian: settings.custodian } : {}),
  };
  // Validate the existing secret store BEFORE committing anything. An unreadable
  // store must never be reinterpreted as an empty one.
  const secrets = loadSecretsUnlocked();
  commitSettingsPair(
    serializeYaml(document),
    serializeYaml({
      providers: secretProviders,
      ...(secrets.teamTicket ? { teamTicket: secrets.teamTicket } : {}),
      ...(secrets.modal ? { modal: { tokenId: secrets.modal.tokenId, tokenSecret: secrets.modal.tokenSecret } } : {}),
    }),
  );
}

export function parseScheduleState(raw: unknown): ScheduleState {
  if (!isRecord(raw)) throw new Error('A Schedule must be a mapping.');
  const allowed = new Set(['id', 'name', 'enabled', 'workspaceRoot', 'originSessionId', 'instruction', 'trigger']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Schedule ${key} is not a supported setting.`);
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id))
    throw new Error('Schedule id must use 1-64 letters, digits, underscores, or dashes.');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128)
    throw new Error('Schedule name must use 1-128 characters.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Schedule enabled must be a boolean.');
  if (typeof raw.workspaceRoot !== 'string' || raw.workspaceRoot.length > 32_768 || !isAbsolute(raw.workspaceRoot))
    throw new Error('Schedule workspaceRoot must be an absolute path.');
  if (raw.originSessionId !== undefined && (typeof raw.originSessionId !== 'string' || raw.originSessionId.length > 256))
    throw new Error('Schedule originSessionId must be a session id under 256 characters.');
  if (typeof raw.instruction !== 'string' || !raw.instruction.trim() || raw.instruction.length > 16_000)
    throw new Error('Schedule instruction must use 1-16000 characters.');
  if (!isRecord(raw.trigger) || Object.keys(raw.trigger).some((key) => key !== 'adapter' && key !== 'options'))
    throw new Error('Schedule trigger must contain adapter and options.');
  if (typeof raw.trigger.adapter !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.trigger.adapter))
    throw new Error('Schedule trigger adapter is invalid.');
  if (!isRecord(raw.trigger.options) || JSON.stringify(raw.trigger.options).length > 16_000)
    throw new Error('Schedule trigger options must be a mapping under 16000 characters.');
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled ?? true,
    workspaceRoot: raw.workspaceRoot,
    originSessionId: typeof raw.originSessionId === 'string' ? raw.originSessionId : '',
    instruction: raw.instruction,
    trigger: { adapter: raw.trigger.adapter, options: raw.trigger.options },
  };
}

export function parseTelegramSettings(raw: unknown): TelegramSettings {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['enabled', 'tokenEnv', 'workspaceRoot', 'chatId', 'userId'].includes(key)))
    throw new Error('telegram contains an unsupported setting.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('telegram.enabled must be a boolean.');
  if (typeof raw.tokenEnv !== 'string' || !isEnvironmentName(raw.tokenEnv))
    throw new Error('telegram.tokenEnv must name an environment variable, not contain a token.');
  if (typeof raw.workspaceRoot !== 'string' || !isAbsolute(raw.workspaceRoot))
    throw new Error('telegram.workspaceRoot must be an absolute path.');
  if ((raw.chatId === undefined) !== (raw.userId === undefined)) throw new Error('telegram chatId and userId must be paired together.');
  if (raw.chatId !== undefined && (typeof raw.chatId !== 'string' || !/^\d{1,20}$/.test(raw.chatId)))
    throw new Error('telegram.chatId must be a private chat id.');
  if (raw.userId !== undefined && (typeof raw.userId !== 'string' || !/^\d{1,20}$/.test(raw.userId)))
    throw new Error('telegram.userId is invalid.');
  return {
    enabled: raw.enabled ?? true,
    tokenEnv: raw.tokenEnv,
    workspaceRoot: raw.workspaceRoot,
    ...(raw.chatId === undefined ? {} : { chatId: raw.chatId as string, userId: raw.userId as string }),
  };
}
