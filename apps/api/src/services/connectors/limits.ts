/**
 * Bounds on one connector exchange. Kept in their own module so live tests
 * can replace them with `vi.mock` instead of waiting 30 seconds.
 */
export const CONNECTOR_LIMITS = {
  /** One MCP request (initialize, tools/list or tools/call), and OAuth calls. */
  timeoutMs: 30_000,
  /** Largest HTTP response body accepted from a connector or its OAuth server. */
  maxResponseBytes: 2 * 1024 * 1024,
  /** Text from one tool result kept for the model; the registry caps the whole result at 16k. */
  maxResultChars: 12_000,
  /** Tools read from one server by "Refresh tools". */
  maxTools: 200,
  /** Largest stored input schema, in characters of JSON. */
  maxSchemaChars: 64_000,
} as const;
