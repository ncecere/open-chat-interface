import { connectorTools } from '../connectors/tools.js';
import type { ToolDefinition } from './types.js';
import { webSearchTool } from './web-search.js';

/**
 * Every tool this instance can offer: the built-in tools, then each enabled
 * tool of each enabled MCP connector (read from the connector store with a
 * short cache that administrator changes clear).
 *
 * There is deliberately no registration API: connector tools come only from
 * what administrators configured, and tests that need another tool (for
 * example a write tool to exercise approvals) replace this module with
 * `vi.mock`.
 */
export async function registeredTools(): Promise<ToolDefinition[]> {
  return [webSearchTool, ...(await connectorTools())];
}
