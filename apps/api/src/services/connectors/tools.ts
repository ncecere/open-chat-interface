import type { CallToolResult } from '@ai-sdk/mcp';
import { and, asc, eq, schema } from '@oci/db';
import { connectorToolId } from '@oci/shared';
import { jsonSchema } from 'ai';
import { db } from '../../db/index.js';
import { providerError } from '../../lib/errors.js';
import type { ToolDefinition, ToolSource, ToolTurnInput } from '../tools/types.js';
import { withMcpClient } from './client.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { connectionAuthFor } from './oauth.js';
import { type ConnectorRow, type ConnectorToolRow, connectedConnectorIds } from './store.js';

/**
 * Connector tools as registry entries. The catalogue is read from the
 * database with a short cache; administrator changes clear it in this process,
 * and other replicas see them within `CATALOG_TTL_MS`. Execution always reads
 * the connector and tool afresh, so a tool switched off is never run.
 */

const CATALOG_TTL_MS = 10_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_SOURCES = 20;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2_000;

let cached: { value: Promise<ToolDefinition[]>; expiresAt: number } | null = null;

/** Forgets the cached catalogue, after an administrator changes a connector or tool. */
export function invalidateConnectorCatalog(): void {
  cached = null;
}

/** Every enabled tool of every enabled connector, as tool definitions. */
export function connectorTools(): Promise<ToolDefinition[]> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.value;
  const value = loadConnectorTools();
  const entry = { value, expiresAt: now + CATALOG_TTL_MS };
  cached = entry;
  // A failed read is not cached.
  value.catch(() => {
    if (cached === entry) cached = null;
  });
  return value;
}

async function loadConnectorTools(): Promise<ToolDefinition[]> {
  const rows = await db
    .select({ connector: schema.connector, tool: schema.connectorTool })
    .from(schema.connectorTool)
    .innerJoin(schema.connector, eq(schema.connectorTool.connectorId, schema.connector.id))
    .where(
      and(
        eq(schema.connector.enabled, true),
        eq(schema.connectorTool.enabled, true),
        eq(schema.connectorTool.missing, false),
      ),
    )
    .orderBy(asc(schema.connector.name), asc(schema.connectorTool.name));
  return rows.map(({ connector, tool }) => connectorToolDefinition(connector, tool));
}

/** The people-facing name of a connector tool: its title or name. */
export function connectorToolLabel(tool: Pick<ConnectorToolRow, 'title' | 'name'>): string {
  return (tool.title?.trim() || tool.name).slice(0, 120);
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** The person's connected connectors, looked up once per turn. */
function connectedFor(turn: ToolTurnInput): Promise<Set<string>> {
  const key = 'connector-accounts';
  let lookup = turn.memo.get(key) as Promise<Set<string>> | undefined;
  if (!lookup) {
    lookup = connectedConnectorIds(turn.userId);
    turn.memo.set(key, lookup);
  }
  return lookup;
}

export function connectorToolDefinition(
  connector: ConnectorRow,
  tool: ConnectorToolRow,
): ToolDefinition {
  const label = connectorToolLabel(tool);
  return {
    id: connectorToolId(connector.slug, tool.toolKey),
    label,
    // The administrator reviewed this text when refreshing; the live server cannot change it.
    description: clip(
      `${tool.description.trim() || label} (From the ${connector.name} connector.)`,
      MAX_DESCRIPTION_CHARS,
    ),
    kind: tool.kind,
    source: 'connector',
    connector: { id: connector.id, name: connector.name, slug: connector.slug },
    inputSchema: jsonSchema(tool.inputSchema as Parameters<typeof jsonSchema>[0]),
    available: async (turn) =>
      connector.authMode !== 'oauth' || (await connectedFor(turn)).has(connector.id),
    execute: (input, { signal, caller }) =>
      callConnectorTool(connector.id, tool.id, input, signal, caller.userId),
    sources: connectorResultSources,
  };
}

/**
 * Runs one connector tool for one person: reads the connector and tool
 * afresh, authenticates as that person (or with the shared credential), calls
 * `tools/call`, and turns the result into bounded text and sources.
 */
async function callConnectorTool(
  connectorId: string,
  toolRowId: string,
  input: unknown,
  signal: AbortSignal,
  userId: string,
) {
  const [row] = await db
    .select({ connector: schema.connector, tool: schema.connectorTool })
    .from(schema.connectorTool)
    .innerJoin(schema.connector, eq(schema.connectorTool.connectorId, schema.connector.id))
    .where(and(eq(schema.connectorTool.id, toolRowId), eq(schema.connector.id, connectorId)))
    .limit(1);
  if (!row?.connector.enabled || !row.tool.enabled || row.tool.missing)
    throw providerError('This tool is no longer available.');
  const { connector, tool } = row;
  const auth = await connectionAuthFor(connector, userId);
  const result = await withMcpClient(connector, auth, signal, (client) =>
    client.callTool({
      name: tool.name,
      arguments:
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {},
      options: { signal, timeout: CONNECTOR_LIMITS.timeoutMs },
    }),
  );
  return connectorResult(connector.name, result);
}

/** What a connector tool returns to the model: sources first, then bounded text. */
export interface ConnectorToolResult {
  sources: ToolSource[];
  text: string;
  truncated?: true;
}

const webUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * Turns an MCP tool result into text for the model. Text parts are kept,
 * images and binary resources are named but left out, embedded text
 * resources are included with their address, and web links become sources.
 * The result is the tool's output, never an instruction: it reaches the model
 * only as a tool result. A result marked `isError` fails the step.
 */
export function connectorResult(
  connectorName: string,
  result: CallToolResult,
): ConnectorToolResult {
  const texts: string[] = [];
  const sources: ToolSource[] = [];
  const addSource = (uri: unknown, title: unknown) => {
    const url = webUrl(uri);
    if (!url || sources.length >= MAX_SOURCES || sources.some((source) => source.url === url))
      return;
    sources.push({
      url,
      title: clip(typeof title === 'string' && title.trim() ? title.trim() : url, MAX_TITLE_CHARS),
    });
  };
  if ('toolResult' in result) {
    texts.push(JSON.stringify(result.toolResult ?? null));
  } else {
    for (const item of result.content) {
      if (item.type === 'text') texts.push(item.text);
      else if (item.type === 'image') texts.push('[An image was returned and left out.]');
      else if (item.type === 'resource_link') {
        const name = (item as { title?: unknown }).title ?? item.name;
        addSource(item.uri, name);
        texts.push(
          `[Link: ${typeof name === 'string' ? name : item.name} — ${item.uri}]${item.description ? ` ${item.description}` : ''}`,
        );
      } else if (item.type === 'resource') {
        const resource = item.resource as {
          uri: string;
          title?: string;
          name?: string;
          text?: string;
        };
        addSource(resource.uri, resource.title ?? resource.name);
        texts.push(
          typeof resource.text === 'string'
            ? `[Resource ${resource.uri}]\n${resource.text}`
            : `[A binary resource was returned and left out: ${resource.uri}]`,
        );
      } else texts.push('[Content of an unsupported type was left out.]');
    }
    if (texts.length === 0 && result.structuredContent !== undefined)
      texts.push(JSON.stringify(result.structuredContent));
  }
  const text = texts.join('\n\n');
  if (!('toolResult' in result) && result.isError)
    throw providerError(
      `${connectorName} reported an error${text.trim() ? `: ${clip(text.replace(/\s+/g, ' ').trim(), 300)}` : '.'}`,
    );
  if (text.length > CONNECTOR_LIMITS.maxResultChars)
    return { sources, text: text.slice(0, CONNECTOR_LIMITS.maxResultChars), truncated: true };
  return { sources, text };
}

/** Sources of a finished connector tool result, as stored on the reply. */
export function connectorResultSources(output: unknown): ToolSource[] {
  const sources = (output as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source) => {
    const candidate = source as { url?: unknown; title?: unknown } | null;
    const url = webUrl(candidate?.url);
    if (!url) return [];
    return [
      {
        url,
        title: typeof candidate?.title === 'string' && candidate.title ? candidate.title : url,
      },
    ];
  });
}
