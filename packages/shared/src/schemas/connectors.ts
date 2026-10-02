import { z } from 'zod';
import { CONNECTOR_SLUG_PATTERN, TOOL_KINDS } from '../tools.js';
import { patchSchema } from './patch.js';

/**
 * MCP connectors (v0.8): remote MCP servers an administrator registers so
 * models can call their tools. See docs/admin/connectors.md.
 */

/** `none`: no credential. `shared`: one header OCI sends for everyone. `oauth`: each person connects. */
export const CONNECTOR_AUTH_MODES = ['none', 'shared', 'oauth'] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

/**
 * Headers OCI sets itself, or that would change how the request is framed or
 * routed. A shared credential may not replace them.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/** An RFC 9110 token: no spaces, colons or line breaks, so it cannot inject headers. */
export const connectorHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Use a header name such as Authorization or X-Api-Key.')
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), {
    message: 'OCI sets this header itself. Use another header name.',
  });

/** Printable characters and tabs only: a line break would start another header. */
export const connectorHeaderValueSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => /^[\t\x20-\x7e\x80-\uffff]+$/.test(value), {
    message: 'The value cannot contain line breaks or control characters.',
  });

const connectorUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url('Enter the server’s full URL, such as https://mcp.example.com/mcp.')
  .refine(
    (value) => {
      // Scheme, then an authority without user info, and no fragment.
      const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
      return authority !== undefined && !authority.includes('@') && !value.includes('#');
    },
    { message: 'Use an https:// URL without a user name, password or #fragment.' },
  );

const connectorFields = z.object({
  name: z.string().trim().min(1).max(80),
  url: connectorUrlSchema,
  authMode: z.enum(CONNECTOR_AUTH_MODES).default('none'),
  /** Header the shared credential is sent in, for example `Authorization`. */
  sharedHeaderName: connectorHeaderNameSchema.default('Authorization'),
  /** Space-separated OAuth scopes to request; empty requests the server's default. */
  oauthScopes: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(true),
  /** Allows plain HTTP and private, loopback and link-local addresses. */
  allowPrivateNetwork: z.boolean().default(false),
});

/** Body of `POST /admin/connectors`. Secrets are write-only. */
export const createConnectorSchema = connectorFields
  .extend({
    /** Chosen from the name when omitted; fixed after creation (tool ids use it). */
    slug: z
      .string()
      .trim()
      .regex(
        CONNECTOR_SLUG_PATTERN,
        'Use up to 24 lowercase letters, digits and hyphens, such as docs or crm-eu.',
      )
      .optional(),
    sharedHeaderValue: connectorHeaderValueSchema.optional(),
    oauthClientId: z.string().trim().min(1).max(500).optional(),
    oauthClientSecret: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.authMode === 'shared' && !input.sharedHeaderValue)
      ctx.addIssue({
        code: 'custom',
        path: ['sharedHeaderValue'],
        message: 'Enter the credential OCI sends to this server.',
      });
    if (input.oauthClientSecret && !input.oauthClientId)
      ctx.addIssue({
        code: 'custom',
        path: ['oauthClientId'],
        message: 'Enter the client ID that goes with this secret.',
      });
  });
export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;

/**
 * Body of `PATCH /admin/connectors/:id`: only sent fields change. Omit a
 * secret to keep it, send a value to replace it, or `null` to clear it.
 */
export const updateConnectorSchema = patchSchema(connectorFields)
  .extend({
    sharedHeaderValue: connectorHeaderValueSchema.nullable().optional(),
    oauthClientId: z.string().trim().min(1).max(500).nullable().optional(),
    oauthClientSecret: z.string().min(1).max(2000).nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'Send at least one change.' });
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;

/**
 * Body of `PATCH /admin/connectors/:id/tools/:toolId`. Marking a tool the
 * server does not declare read-only as `read` needs `confirmReadOnly`.
 */
export const updateConnectorToolSchema = z
  .object({
    enabled: z.boolean().optional(),
    kind: z.enum(TOOL_KINDS).optional(),
    confirmReadOnly: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.enabled !== undefined || input.kind !== undefined, {
    message: 'Send at least one change.',
  });
export type UpdateConnectorToolInput = z.infer<typeof updateConnectorToolSchema>;

export const connectorToolSchema = z.object({
  id: z.string(),
  /** The id models and role allows use: `mcp__<slug>__<tool>`. */
  toolId: z.string(),
  /** The tool's name on the MCP server. */
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  kind: z.enum(TOOL_KINDS),
  /** What the server declares: `read` only with the `readOnlyHint` annotation. */
  serverKind: z.enum(TOOL_KINDS),
  enabled: z.boolean(),
  /** Not listed by the server at the last refresh; never offered while missing. */
  missing: z.boolean(),
  lastSeenAt: z.string(),
});
export type ConnectorTool = z.infer<typeof connectorToolSchema>;

/** A connector as administrators see it. Secrets are reported as set or not set. */
export const adminConnectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  url: z.string(),
  authMode: z.enum(CONNECTOR_AUTH_MODES),
  sharedHeaderName: z.string(),
  hasSharedCredential: z.boolean(),
  oauthClientId: z.string().nullable(),
  hasOauthClientSecret: z.boolean(),
  /** `dynamic` when OCI registered itself with the server's authorization server. */
  oauthClientSource: z.enum(['manual', 'dynamic']).nullable(),
  oauthScopes: z.string(),
  enabled: z.boolean(),
  allowPrivateNetwork: z.boolean(),
  /** People connected to this OAuth connector. */
  accountCount: z.number(),
  lastContactAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Where the server's OAuth redirect comes back to; register it with the server. */
  oauthRedirectUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tools: z.array(connectorToolSchema),
});
export type AdminConnector = z.infer<typeof adminConnectorSchema>;

/** Result of `POST /admin/connectors/:id/test`. */
export const connectorTestResultSchema = z.object({
  ok: z.boolean(),
  /** One line for the administrator, such as "Connected to Docs 1.2 · 4 tools". */
  detail: z.string(),
});
export type ConnectorTestResult = z.infer<typeof connectorTestResultSchema>;

/** Result of `POST /admin/connectors/:id/refresh`. */
export const connectorRefreshResultSchema = z.object({
  added: z.number(),
  updated: z.number(),
  missing: z.number(),
  tools: z.array(connectorToolSchema),
});
export type ConnectorRefreshResult = z.infer<typeof connectorRefreshResultSchema>;

/** An OAuth connector as a person sees it under Settings → Connectors. */
export const userConnectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  connected: z.boolean(),
  /** A connection that expired or was refused and has to be made again. */
  needsReconnect: z.boolean(),
  /** Tools of this connector the person's role may use. */
  toolCount: z.number(),
});
export type UserConnector = z.infer<typeof userConnectorSchema>;

/** Body of `POST /api/connectors/:id/connect`. */
export const startConnectorConnectSchema = z
  .object({ returnTo: z.enum(['settings', 'admin']).default('settings') })
  .strict();
