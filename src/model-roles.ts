/**
 * Role-bound models: which provider/model each kind of run starts on.
 *
 * One resolver decides for every role - a role the owner assigned wins when it
 * is ready, and anything unset or unusable falls through to the shared default
 * chain (explicit default, then most-used), so an unconfigured machine behaves
 * exactly as before. Roles are read, never written, here: only the settings
 * commands change assignments.
 */
import { modelIsUsable } from './provider/registry.js';
import { resolveDefaultModel, type DefaultModelChoice } from './usage/default-model.js';
import type { SettingsStore } from './settings.js';

/** named assignment entry: { agent, custodian, worker, background, title, review }. */
export type ModelRole = 'agent' | 'custodian' | 'worker' | 'background' | 'title' | 'review';

const KNOWN_ROLES: readonly ModelRole[] = ['agent', 'custodian', 'worker', 'background', 'title', 'review'];

export function isModelRole(value: string): value is ModelRole {
  return (KNOWN_ROLES as readonly string[]).includes(value);
}

export function modelRoles(): readonly ModelRole[] {
  return KNOWN_ROLES;
}

/** A whole pair straight from settings; no validation here (parse validates). */
export interface RoleModelAssignment {
  providerId: string;
  modelId: string;
}

/**
 * The role's assigned pair, including the two single-purpose fields that
 * predate the roles map: the permission reviewer and the custodian each carry
 * their own provider/model the old way, and both remain readable so existing
 * settings keep working without an owner-visible migration step.
 */
export function roleModelAssignment(settings: SettingsStore, role: ModelRole): RoleModelAssignment | null {
  const entry = settings.roles?.[role];
  if (entry?.provider && entry.model) return { providerId: entry.provider, modelId: entry.model };
  if (role === 'review' && settings.autoReviewProvider && settings.autoReviewModel) {
    return { providerId: settings.autoReviewProvider, modelId: settings.autoReviewModel };
  }
  if (role === 'custodian' && settings.custodian?.provider && settings.custodian?.model) {
    return { providerId: settings.custodian.provider, modelId: settings.custodian.model };
  }
  return null;
}

/**
 * The model a run on `role` starts with: the role's assignment when the owner
 * made one and it is ready, otherwise the shared default. An assignment that is
 * no longer usable (provider disabled, key gone) degrades to the default
 * instead of failing the run - a role bound to a broken target must not take
 * every worker down with it.
 */
export function resolveRoleModel(
  settings: SettingsStore,
  role: ModelRole,
  ledger?: Parameters<typeof resolveDefaultModel>[1],
): DefaultModelChoice | null {
  const assignment = roleModelAssignment(settings, role);
  if (assignment && modelIsUsable(settings, assignment.providerId, assignment.modelId)) {
    return { ...assignment, source: 'role' };
  }
  return resolveDefaultModel(settings, ledger);
}

/**
 * The one writer for role assignments. `review` also mirrors the legacy
 * autoReview fields the same moment it writes, so every reader - CLI status,
 * the approvals screen - and both write paths always describe one pair. Other
 * roles write to the map; `custodian` keeps no mirror because its legacy pair
 * was never wired to a writer.
 */
export function assignRoleModel(settings: SettingsStore, role: ModelRole, assignment: RoleModelAssignment | null): void {
  const roles = { ...settings.roles };
  if (assignment) {
    roles[role] = { provider: assignment.providerId, model: assignment.modelId };
  } else {
    delete roles[role];
  }
  if (Object.keys(roles).length > 0) settings.roles = roles;
  else delete settings.roles;
  if (role === 'review') {
    if (assignment) {
      settings.autoReviewProvider = assignment.providerId;
      settings.autoReviewModel = assignment.modelId;
    } else {
      delete settings.autoReviewProvider;
      delete settings.autoReviewModel;
    }
  }
}

/** Identity for reload comparison: a change to the pair (or its provider config) is a rebuild. */
export function roleModelConfig(settings: SettingsStore, role: ModelRole): string {
  const assignment = roleModelAssignment(settings, role);
  return JSON.stringify([
    assignment?.providerId ?? null,
    assignment?.modelId ?? null,
    assignment ? (settings.providers[assignment.providerId] ?? null) : null,
  ]);
}
