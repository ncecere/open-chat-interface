import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { discoverModels } from '../../services/providers/registry.js';

/** Discover models on an unreachable provider says why, not "fetch failed" (#228). */
describe('model discovery failures', () => {
  it('names a refused connection and an unknown address in words', async () => {
    // A port that was just free: nothing listens on it.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const discover = (baseUrl: string) =>
      discoverModels({ kind: 'openai-compatible', baseUrl, apiKey: null } as never).then(
        () => 'answered',
        (error: Error) => error.message,
      );

    const refused = await discover(`http://127.0.0.1:${port}/v1`);
    expect(refused).toBe(
      'Could not reach the provider: it refused the connection. Check the base URL and port.',
    );
    expect(refused).not.toContain('fetch failed');

    // .invalid never resolves (RFC 2606).
    expect(await discover('http://walk3-provider.invalid/v1')).toBe(
      'Could not reach the provider: its address could not be found. Check the base URL.',
    );
  });
});
