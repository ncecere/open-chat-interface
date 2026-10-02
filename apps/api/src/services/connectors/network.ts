import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Outbound HTTP for MCP connectors and their OAuth servers.
 *
 * Every request goes through `createGuardedFetch`, which:
 * - allows only `https:` (and `http:` when the connector allows private networks);
 * - refuses private, loopback, link-local, metadata and other special-purpose
 *   addresses unless the connector allows private networks, checking the
 *   address the socket actually connects to (the DNS answer is validated
 *   inside the connection's own lookup, so a rebinding answer between a check
 *   and the connection cannot slip through);
 * - never follows redirects;
 * - limits response size and idle time, and opens a fresh socket per request
 *   so a validated connection is never shared with another connector.
 */

/** A refused or failed connector request. Its message is safe to show people. */
export class ConnectorNetworkError extends Error {
  constructor(
    message: string,
    readonly reason: 'protocol' | 'address' | 'dns' | 'redirect' | 'too-large' | 'timeout',
  ) {
    super(message);
    this.name = 'ConnectorNetworkError';
  }
}

interface NetworkPolicy {
  /** Plain HTTP and private addresses are allowed (administrator's explicit choice). */
  allowPrivateNetwork: boolean;
  /** Largest response body accepted, in bytes. */
  maxResponseBytes?: number;
  /** Socket idle time before the request is abandoned. */
  idleTimeoutMs?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Special-purpose ranges (RFC 6890 and successors). IPv4 rules also match
 * IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) in Node's BlockList.
 * Embedded-IPv4 forms that are not mapped (NAT64, 6to4, IPv4-compatible) are
 * refused outright.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network", including 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['::', 96], // IPv4-compatible (deprecated)
  // IPv4-mapped addresses (::ffff:a.b.c.d) are matched by the IPv4 rules above;
  // a ::ffff:0:0/96 rule here would also match every plain IPv4 address.
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local, including fd00:ec2::254 metadata
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv6');

/**
 * Cloud instance-metadata services. Refused even with "Allow private
 * network": no MCP server lives there, and they hand out credentials.
 */
const METADATA = new BlockList();
METADATA.addAddress('169.254.169.254', 'ipv4'); // AWS, GCP, Azure, OpenStack
METADATA.addAddress('169.254.170.2', 'ipv4'); // AWS ECS task metadata
METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud
METADATA.addAddress('fd00:ec2::254', 'ipv6'); // AWS over IPv6

/** True for an address a public MCP server may have. Exported for tests. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** True for a cloud metadata address. Exported for tests. */
export function isMetadataAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return METADATA.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether a connection to this address is allowed under the policy. */
function addressAllowed(address: string, policy: NetworkPolicy): boolean {
  if (isMetadataAddress(address)) return false;
  return policy.allowPrivateNetwork || isPublicAddress(address);
}

const ADDRESS_REFUSED =
  'This address is on a private or reserved network. Turn on “Allow private network” only for servers you control.';

/** `[::1]` → `::1`; WHATWG URLs bracket IPv6 hosts. */
const bareHost = (hostname: string) => hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * Checks a URL before any connection: the scheme, and the host when it is an
 * IP literal (sockets skip DNS lookup for those). Host names are checked when
 * they are resolved, inside the connection.
 */
export function assertAllowedUrl(raw: string | URL, policy: NetworkPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorNetworkError('The address is not a valid URL.', 'protocol');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowPrivateNetwork))
    throw new ConnectorNetworkError(
      'Use an https:// address. Plain http:// is allowed only with “Allow private network”.',
      'protocol',
    );
  if (url.username || url.password)
    throw new ConnectorNetworkError(
      'The address cannot contain a user name or password.',
      'protocol',
    );
  const host = bareHost(url.hostname);
  if (isIP(host) && !addressAllowed(host, policy))
    throw new ConnectorNetworkError(ADDRESS_REFUSED, 'address');
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for the request's socket that refuses any answer containing a
 * non-public address. The socket connects to exactly what this returns, so the
 * checked address is the connected one.
 */
function guardedLookup(policy: NetworkPolicy) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(
          Object.assign(
            new ConnectorNetworkError('The server’s name could not be resolved.', 'dns'),
            {
              code: error.code,
            },
          ),
          [],
        );
        return;
      }
      if (addresses.some((entry) => !addressAllowed(entry.address, policy))) {
        callback(new ConnectorNetworkError(ADDRESS_REFUSED, 'address'), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else {
        const [first] = addresses;
        if (!first) {
          callback(
            new ConnectorNetworkError('The server’s name could not be resolved.', 'dns'),
            [],
          );
          return;
        }
        callback(null, first.address, first.family);
      }
    });
  };
}

/** Status codes whose responses must not carry a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Ends the stream with an error once more than `limit` bytes have passed. */
function limitBytes(source: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          controller.error(
            new ConnectorNetworkError('The server’s response was too large.', 'too-large'),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** A `fetch` for connector traffic. See the module comment for what it enforces. */
export function createGuardedFetch(policy: NetworkPolicy): typeof fetch {
  const maxBytes = policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const idleTimeoutMs = policy.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = assertAllowedUrl(request.url, policy);
    const method = request.method.toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (body) headers['content-length'] = String(body.byteLength);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      let outgoing: http.ClientRequest;
      try {
        outgoing = transport.request(url, {
          method,
          headers,
          // A fresh socket per request: never reuse a connection validated for another policy.
          agent: false,
          lookup: guardedLookup(policy) as never,
          signal,
          timeout: idleTimeoutMs,
        });
      } catch (error) {
        // Invalid header names or values (for example a line break) throw here.
        reject(error);
        return;
      }
      outgoing.on('timeout', () =>
        outgoing.destroy(
          new ConnectorNetworkError('The server did not respond in time.', 'timeout'),
        ),
      );
      outgoing.on('error', reject);
      outgoing.on('response', (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.resume();
          outgoing.destroy();
          reject(
            new ConnectorNetworkError(
              'The server answered with a redirect. Enter the final address instead.',
              'redirect',
            ),
          );
          return;
        }
        const declared = Number(incoming.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          incoming.destroy();
          reject(new ConnectorNetworkError('The server’s response was too large.', 'too-large'));
          return;
        }
        const responseHeaders = new Headers();
        for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index]!;
          const value = incoming.rawHeaders[index + 1]!;
          try {
            responseHeaders.append(name, value);
          } catch {
            // A header the Fetch API cannot represent is dropped.
          }
        }
        const stream =
          NULL_BODY_STATUSES.has(status) || method === 'HEAD'
            ? null
            : limitBytes(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, maxBytes);
        if (!stream) incoming.resume();
        resolve(
          new Response(stream, {
            status: status < 200 || status > 599 ? 502 : status,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      });
      outgoing.end(body);
    });
  }) as typeof fetch;
}

/** The first ConnectorNetworkError in an error's cause chain, if any. */
export function findNetworkError(error: unknown): ConnectorNetworkError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof ConnectorNetworkError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
