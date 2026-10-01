import { createRequire } from 'node:module';
import { createServer, Socket } from 'node:net';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const drivers = [
  { name: 'ESM', driver: postgres },
  { name: 'CommonJS', driver: require('postgres') as typeof postgres },
];

/** No external database: a protocol peer authenticates, then ignores queries and FIN. */
describe.each(drivers)('Postgres.js $name bounded transport shutdown', ({ driver }) => {
  it('destroys the client socket when an unlock response never arrives', async () => {
    const peers = new Set<Socket>();
    let queryArrived!: () => void;
    const sawQuery = new Promise<void>((resolve) => {
      queryArrived = resolve;
    });
    const server = createServer({ allowHalfOpen: true }, (peer) => {
      peers.add(peer);
      let startup = true;
      let buffered = Buffer.alloc(0);
      peer.on('error', () => {});
      peer.on('data', (data: Buffer) => {
        if (!startup) {
          queryArrived();
          return;
        }
        buffered = Buffer.concat([buffered, data]);
        if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0)) return;
        startup = false;
        // AuthenticationOk followed by ReadyForQuery (idle). The subsequent
        // query is deliberately never answered; allowHalfOpen keeps the peer's
        // writable half open after the driver sends its termination/FIN.
        peer.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    let socket!: Socket;
    // The documented socket hook exposes the real transport for assertion;
    // query execution and shutdown use the installed driver, not mocks.
    const options = {
      max: 1,
      ssl: false,
      prepare: false,
      fetch_types: false,
      username: 'test',
      database: 'test',
      socket: () =>
        new Promise<Socket>((resolve, reject) => {
          socket = new Socket();
          socket.once('error', reject);
          socket.connect(address.port, '127.0.0.1', () => resolve(socket));
        }),
    };
    const client = driver(options);
    const query = client`select pg_advisory_unlock(123::bigint)`.catch(
      (error: { code: string }) => error,
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sawQuery,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Test peer did not receive a query')),
            5_000,
          );
        }),
      ]);
      await client.end({ timeout: 0.02 });
      expect(await query).toMatchObject({ code: 'CONNECTION_DESTROYED' });
      expect(socket.destroyed).toBe(true);
    } finally {
      clearTimeout(deadline);
      // Also clean up after the unpatched driver's failing baseline.
      socket?.destroy();
      for (const peer of peers) peer.destroy();
      await client.end({ timeout: 0 });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 10_000);
});
