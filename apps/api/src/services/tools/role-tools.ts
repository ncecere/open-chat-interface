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
  tools: readonly ToolDefinition[],
): RoleTool[] {
  return tools.map((tool) => ({
    id: tool.id,
    label: tool.label,
    kind: tool.kind,
    source: tool.source,
    allowed: resolveRoleToolAllowed(role, tool, stored),
    connector: tool.connector?.name ?? null,
  }));
}

export async function roleTools(role: UserRole): Promise<RoleTool[]> {
  const [stored, tools] = await Promise.all([getSetting('roleTools'), registeredTools()]);
  return describeRoleTools(role, stored, tools);
}

/** Saves only the sent tools for one role; unknown tool ids are refused. */
export async function updateRoleTools(
  role: UserRole,
  patch: UpdateRoleToolsInput,
): Promise<RoleTool[]> {
  const known = new Set((await registeredTools()).map((tool) => tool.id));
  const unknown = Object.keys(patch.tools).filter((id) => !known.has(id));
  if (unknown.length) throw validationFailed(`Unknown tool: ${unknown.join(', ')}`);
  const current = await getSetting('roleTools');
  const roles = { ...current.roles };
  roles[role] = { ...roles[role], ...patch.tools };
  await updateSetting('roleTools', { roles });
  return roleTools(role);
}

/**
 * Forgets every role's saved choice for tools whose id starts with `prefix`
 * (a deleted connector's `mcp__<slug>__`), so a later connector reusing the
 * slug starts from the default (off).
 */
export async function forgetRoleTools(prefix: string): Promise<void> {
  const current = await getSetting('roleTools');
  let changed = false;
  const roles = Object.fromEntries(
    Object.entries(current.roles ?? {}).map(([role, saved = {}]) => {
      const kept = Object.fromEntries(
        Object.entries(saved).filter(([id]) => !id.startsWith(prefix)),
      );
      if (Object.keys(kept).length !== Object.keys(saved).length) changed = true;
      return [role, kept];
    }),
  );
  if (changed) await updateSetting('roleTools', { roles });
}
