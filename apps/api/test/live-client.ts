/**
 * A browser-like client for the live suites: a cookie jar over `app.request`,
 * so a sign-in's `Set-Cookie` (and the session swap when two-step verification
 * is confirmed or turned off) is carried into the next request as a browser
 * would. Responses come back parsed.
 */
export interface LiveResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

interface Requestable {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

export class LiveClient {
  readonly jar = new Map<string, string>();

  constructor(
    private readonly app: Requestable,
    private readonly origin: string,
    /** Sent as the User-Agent so audit entries and devices read like a browser's. */
    private readonly userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36',
  ) {}

  get cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** The session cookie's value (its token and signature), or undefined when signed out. */
  get sessionCookie(): string | undefined {
    return this.jar.get('oci.session_token');
  }

  /** A second client that starts with the same cookies (another tab). */
  clone(): LiveClient {
    const copy = new LiveClient(this.app, this.origin, this.userAgent);
    for (const [name, value] of this.jar) copy.jar.set(name, value);
    return copy;
  }

  private absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (!value || expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request<T = unknown>(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<LiveResponse<T>> {
    const method = init.method ?? (init.json === undefined ? 'GET' : 'POST');
    const response = await this.app.request(path, {
      method,
      headers: {
        origin: this.origin,
        'user-agent': this.userAgent,
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.jar.size > 0 ? { cookie: this.cookieHeader } : {}),
        ...init.headers,
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    });
    this.absorb(response);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (a redirect, an empty body): the text stays.
    }
    return { status: response.status, body: body as T, headers: response.headers, text };
  }
}
