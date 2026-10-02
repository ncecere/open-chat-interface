import {
  defaultToolAllowed,
  type RoleTool,
  type UpdateRoleToolsInput,
  type UserRole,
} from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';
import { getSetting, type StoredRoleToolSettings, updateSetting } from '../settings.js';
import { registeredTools } from './catalog.js';
import type { ToolDefinition } from './types.js';

/**
 * Whether a role may use a tool: the saved choice, else the default (built-in
 * read tools on except for `restricted`; everything else off). Pure so the
 * precedence is testable without a database.
 */
export function resolveRoleToolAllowed(
  role: UserRole,
  tool: Pick<ToolDefinition, 'id' | 'kind' | 'source'>,
  stored: StoredRoleToolSettings | undefined,
): boolean {
  const saved = stored?.roles?.[role]?.[tool.id];
  return typeof saved === 'boolean' ? saved : defaultToolAllowed(role, tool);
}

/** Every registered tool with this role's allow, for Roles & access. */
export function describeRoleTools(
  role: UserRole,
  stored: StoredRoleToolSettings | undefined,
): RoleTool[] {
  return registeredTools().map((tool) => ({
    id: tool.id,
    label: tool.label,
    kind: tool.kind,
    source: tool.source,
    allowed: resolveRoleToolAllowed(role, tool, stored),
  }));
}

export async function roleTools(role: UserRole): Promise<RoleTool[]> {
  return describeRoleTools(role, await getSetting('roleTools'));
}

/** Saves only the sent tools for one role; unknown tool ids are refused. */
export async function updateRoleTools(
  role: UserRole,
  patch: UpdateRoleToolsInput,
): Promise<RoleTool[]> {
  const known = new Set(registeredTools().map((tool) => tool.id));
  const unknown = Object.keys(patch.tools).filter((id) => !known.has(id));
  if (unknown.length) throw validationFailed(`Unknown tool: ${unknown.join(', ')}`);
  const current = await getSetting('roleTools');
  const roles = { ...current.roles };
  roles[role] = { ...roles[role], ...patch.tools };
  await updateSetting('roleTools', { roles });
  return roleTools(role);
}
