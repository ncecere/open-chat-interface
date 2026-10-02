import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  connectorSlugOfToolId,
  connectorToolId,
  createConnectorSchema,
  TOOL_ID_PATTERN,
  updateConnectorSchema,
  updateConnectorToolSchema,
} from '@oci/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { AppError } = await import('../../lib/errors.js');
const {
  assertAllowedUrl,
  ConnectorNetworkError,
  createGuardedFetch,
  findNetworkError,
  isMetadataAddress,
  isPublicAddress,
} = await import('../../services/connectors/network.js');
const { maxToolKeyLength, slugFromName, toolKeyFor } = await import(
  '../../services/connectors/ids.js'
);
const { connectorResult, connectorResultSources, connectorToolLabel } = await import(
  '../../services/connectors/tools.js'
);
const { connectorFailure } = await import('../../services/connectors/client.js');
const { serverKindOf } = await import('../../services/connectors/admin.js');

describe('address checks', () => {
  it('refuses private, loopback, link-local, metadata and special addresses', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd00:ec2::254',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'not-an-address',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    for (const address of [
      '93.184.216.34',
      '1.1.1.1',
      '172.32.0.1',
      '::ffff:93.184.216.34',
      '2606:4700:4700::1111',
    ])
      expect(isPublicAddress(address), address).toBe(true);
    expect(isMetadataAddress('169.254.169.254')).toBe(true);
    expect(isMetadataAddress('fd00:ec2::254')).toBe(true);
    expect(isMetadataAddress('10.0.0.1')).toBe(false);
    expect(isMetadataAddress('nope')).toBe(false);
  });

  it('allows only https, or http with the private-network flag, and never metadata', () => {
    const strict = { allowPrivateNetwork: false };
    const open = { allowPrivateNetwork: true };
    expect(assertAllowedUrl('https://mcp.example.test/mcp', strict).hostname).toBe(
      'mcp.example.test',
    );
    const refusal = (url: string, policy = strict) => {
      try {
        assertAllowedUrl(url, policy);
      } catch (error) {
        return (error as InstanceType<typeof ConnectorNetworkError>).reason;
      }
      return null;
    };
    expect(refusal('http://mcp.example.test/')).toBe('protocol');
    expect(refusal('ftp://mcp.example.test/', open)).toBe('protocol');
    expect(refusal('not a url')).toBe('protocol');
    expect(refusal('https://a:b@mcp.example.test/', open)).toBe('protocol');
    expect(refusal('https://127.0.0.1/')).toBe('address');
    expect(refusal('https://[::1]/')).toBe('address');
    expect(refusal('https://0x7f.1/')).toBe('address');
    expect(refusal('https://2130706433/')).toBe('address');
    expect(refusal('http://169.254.169.254/', open)).toBe('address');
    expect(refusal('http://[fd00:ec2::254]/', open)).toBe('address');
    expect(refusal('http://127.0.0.1:8080/', open)).toBeNull();
  });
});

describe('guarded fetch', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/' });
        response.end();
      } else if (request.url === '/big') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10000' });
        response.end('x'.repeat(10_000));
      } else if (request.url === '/stream') {
        // No content-length: the limit applies while reading.
        response.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
        response.write('y'.repeat(6_000));
        response.end('y'.repeat(6_000));
      } else if (request.url === '/empty') {
        response.writeHead(204);
        response.end();
      } else if (request.url === '/slow') {
        setTimeout(() => response.end('late'), 500);
      } else {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-echo': request.headers['x-key'] ?? '',
        });
        request.pipe(response);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = createGuardedFetch({ allowPrivateNetwork: true, maxResponseBytes: 8_000 });

  it('sends the request and streams the response', async () => {
    const response = await open(new URL(`${origin}/echo`), {
      method: 'POST',
      headers: { 'x-key': 'k1' },
      body: new URLSearchParams({ a: '1' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-echo')).toBe('k1');
    expect(await response.text()).toBe('a=1');
    expect((await open(`${origin}/empty`)).status).toBe(204);
  });

  it('refuses redirects, oversize bodies and header injection', async () => {
    await expect(open(`${origin}/redirect`)).rejects.toMatchObject({ reason: 'redirect' });
    await expect(open(`${origin}/big`)).rejects.toMatchObject({ reason: 'too-large' });
    const streamed = await open(`${origin}/stream`);
    await expect(streamed.text()).rejects.toMatchObject({ reason: 'too-large' });
    await expect(
      open(`${origin}/echo`, { headers: { 'x-key': 'a\r\nInjected: 1' } }),
    ).rejects.toThrow();
  });

  it('checks the address a name resolves to, unless private networks are allowed', async () => {
    const strict = createGuardedFetch({ allowPrivateNetwork: false });
    const port = new URL(origin).port;
    // localhost resolves to loopback: refused at connection time, before any request.
    await expect(strict(`https://localhost:${port}/echo`)).rejects.toMatchObject({
      reason: 'address',
    });
    await expect(strict(`${origin}/echo`)).rejects.toMatchObject({ reason: 'protocol' });
    const viaName = await open(`http://localhost:${port}/echo`, { method: 'POST', body: 'ok' });
    expect(await viaName.text()).toBe('ok');
    await expect(
      createGuardedFetch({ allowPrivateNetwork: true })('http://no-such-host.invalid/'),
    ).rejects.toMatchObject({ reason: 'dns' });
  });

  it('gives up on an idle server and honours an abort', async () => {
    const impatient = createGuardedFetch({ allowPrivateNetwork: true, idleTimeoutMs: 100 });
    await expect(impatient(`${origin}/slow`)).rejects.toMatchObject({ reason: 'timeout' });
    await expect(open(`${origin}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(open(`${origin}/echo`, { signal: aborted.signal })).rejects.toThrow();
  });
});

describe('ids', () => {
  it('derives slugs and provider-safe tool keys', () => {
    expect(slugFromName('Team Docs (EU)')).toBe('team-docs-eu');
    expect(slugFromName('Ünïcödé Wiki')).toBe('unicode-wiki');
    expect(slugFromName('***')).toBe('connector');
    expect(slugFromName('a'.repeat(40))).toBe('a'.repeat(24));
    expect(toolKeyFor('docs', 'search', new Set())).toBe('search');
    expect(toolKeyFor('docs', 'files.read', new Set())).toBe('files_read');
    const collided = toolKeyFor('docs', 'files.read', new Set(['files_read']));
    expect(collided).toMatch(/^files_read_[0-9a-f]{8}$/);
    const long = toolKeyFor('a'.repeat(24), 'x'.repeat(100), new Set());
    expect(long.length).toBe(maxToolKeyLength('a'.repeat(24)));
    const id = connectorToolId('a'.repeat(24), long);
    expect(id.length).toBe(64);
    expect(TOOL_ID_PATTERN.test(id)).toBe(true);
    expect(connectorSlugOfToolId(id)).toBe('a'.repeat(24));
    expect(connectorSlugOfToolId('web_search')).toBeNull();
    // Keeps going when even the hashed key is taken.
    expect(toolKeyFor('docs', 'files.read', new Set(['files_read', collided]))).toMatch(
      /^files_read1_[0-9a-f]{8}$/,
    );
  });
});

describe('results', () => {
  it('keeps text, names left-out content, and turns web links into sources', () => {
    const result = connectorResult('Docs', {
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        {
          type: 'resource_link',
          uri: 'https://a.test/x',
          name: 'x',
          title: 'X doc',
          description: 'about x',
        },
        { type: 'resource_link', uri: 'https://a.test/x', name: 'duplicate' },
        { type: 'resource_link', uri: 'javascript:alert(1)', name: 'bad' },
        { type: 'resource', resource: { uri: 'https://b.test/y', name: 'y', text: 'Body of y' } },
        { type: 'resource', resource: { uri: 'file:///z', blob: 'aGk=' } },
      ],
    } as never);
    expect(result.sources).toEqual([
      { url: 'https://a.test/x', title: 'X doc' },
      { url: 'https://b.test/y', title: 'y' },
    ]);
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('[An image was returned and left out.]');
    expect(result.text).toContain('[Link: X doc — https://a.test/x] about x');
    expect(result.text).toContain('[Resource https://b.test/y]\nBody of y');
    expect(result.text).toContain('[A binary resource was returned and left out: file:///z]');
    expect(
      connectorResult('Docs', { content: [], structuredContent: { a: 1 } } as never).text,
    ).toBe('{"a":1}');
    expect(connectorResult('Docs', { toolResult: { b: 2 } } as never).text).toBe('{"b":2}');
    expect(() => connectorResult('Docs', { content: [], isError: true } as never)).toThrow(
      'Docs reported an error.',
    );
    expect(
      connectorResultSources({
        sources: [{ url: 'https://a.test', title: '' }, { url: 'ftp://x' }],
      }),
    ).toEqual([{ url: 'https://a.test/', title: 'https://a.test/' }]);
    expect(connectorResultSources(null)).toEqual([]);
    expect(connectorToolLabel({ title: '  ', name: 'search' })).toBe('search');
  });

  it('describes failures in its own words', () => {
    const message = (error: unknown, signal?: AbortSignal, reconnect?: string) =>
      connectorFailure('Docs', error, signal, { reconnectMessage: reconnect }).message;
    const existing = new AppError('VALIDATION_FAILED', 'Mine', 422);
    expect(connectorFailure('Docs', existing, undefined)).toBe(existing);
    expect(message(new ConnectorNetworkError('Too big.', 'too-large'))).toBe(
      'Docs could not be used. Too big.',
    );
    expect(
      message(new Error('wrapped', { cause: new ConnectorNetworkError('x', 'timeout') })),
    ).toBe('Docs did not respond in time.');
    expect(
      message(
        Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' }),
        undefined,
        'Reconnect.',
      ),
    ).toBe('Reconnect.');
    expect(message({ statusCode: 401 })).toContain('refused OCI’s credentials');
    expect(message({ statusCode: 500, message: 'secret body' })).toBe(
      'Docs returned an error (HTTP 500).',
    );
    expect(message({ code: -32602, message: '  Unknown   tool ' })).toBe(
      'Docs returned an error: Unknown tool',
    );
    expect(message(new Error('boom'))).toBe('Docs could not be reached.');
    expect(message(new Error('boom'), AbortSignal.abort())).toBe('Docs did not respond in time.');
    expect(findNetworkError(null)).toBeNull();
  });

  it('defaults kinds from readOnlyHint only', () => {
    expect(serverKindOf({ annotations: { readOnlyHint: true } })).toBe('read');
    expect(serverKindOf({ annotations: { readOnlyHint: 'true' } })).toBe('write');
    expect(serverKindOf({})).toBe('write');
  });
});

describe('schemas', () => {
  it('validates connectors and tool changes', () => {
    const base = { name: 'Docs', url: 'https://mcp.example.test/mcp' };
    expect(createConnectorSchema.parse(base)).toMatchObject({
      authMode: 'none',
      sharedHeaderName: 'Authorization',
      enabled: true,
      allowPrivateNetwork: false,
    });
    expect(
      createConnectorSchema.safeParse({ ...base, url: 'https://mcp.example.test/#x' }).success,
    ).toBe(false);
    expect(createConnectorSchema.safeParse({ ...base, slug: 'Bad_Slug' }).success).toBe(false);
    expect(createConnectorSchema.safeParse({ ...base, oauthClientSecret: 's' }).success).toBe(
      false,
    );
    expect(createConnectorSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    // Omitted fields stay unchanged rather than reset to defaults.
    expect(updateConnectorSchema.parse({ name: 'New' })).toEqual({ name: 'New' });
    expect(updateConnectorSchema.parse({ sharedHeaderValue: null })).toEqual({
      sharedHeaderValue: null,
    });
    expect(updateConnectorSchema.safeParse({}).success).toBe(false);
    expect(updateConnectorToolSchema.safeParse({ confirmReadOnly: true }).success).toBe(false);
    expect(
      updateConnectorToolSchema.safeParse({ kind: 'read', confirmReadOnly: true }).success,
    ).toBe(true);
  });
});
