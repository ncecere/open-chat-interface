import { createHash } from 'node:crypto';
import { CONNECTOR_SLUG_PATTERN, connectorToolId, MAX_TOOL_ID_LENGTH } from '@oci/shared';

/** A slug from a connector's name: `Team Docs (EU)` → `team-docs-eu`. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return CONNECTOR_SLUG_PATTERN.test(slug) ? slug : 'connector';
}

/** The longest tool key that keeps `mcp__<slug>__<key>` within the provider limit. */
export function maxToolKeyLength(slug: string): number {
  return MAX_TOOL_ID_LENGTH - connectorToolId(slug, '').length;
}

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

/**
 * A provider-safe key for an MCP tool name, unique within its connector.
 * Characters outside `[A-Za-z0-9_-]` become `_`; a name that is too long, or
 * whose key another tool already has, ends in a short hash of the full name.
 * Keys are stored once assigned, so a tool keeps its id across refreshes.
 */
export function toolKeyFor(slug: string, name: string, taken: ReadonlySet<string>): string {
  const max = maxToolKeyLength(slug);
  const plain = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  if (plain.length <= max && !taken.has(plain)) return plain;
  const hashed = `${plain.slice(0, max - 9)}_${shortHash(name)}`;
  if (!taken.has(hashed)) return hashed;
  // Two names hashing alike within one connector: astronomically unlikely, but never reuse a key.
  for (let attempt = 1; ; attempt++) {
    const candidate = `${plain.slice(0, max - 9 - String(attempt).length)}${attempt}_${shortHash(name)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
