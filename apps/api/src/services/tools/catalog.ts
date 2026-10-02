import type { ToolDefinition } from './types.js';
import { webSearchTool } from './web-search.js';

/**
 * Every tool this instance can offer. There is deliberately no registration
 * API: tests that need another tool (for example a write tool to exercise
 * approvals) replace this module with `vi.mock`, so production code has no way
 * to add tools at runtime. MCP connector tools will be appended here from the
 * connector store.
 */
export function registeredTools(): ToolDefinition[] {
  return [webSearchTool];
}
