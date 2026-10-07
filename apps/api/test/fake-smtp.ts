import { createServer, type Server, type Socket } from 'node:net';

/**
 * A throwaway SMTP server for tests: just enough of the protocol for
 * nodemailer (no TLS, no authentication), keeping every message it accepts.
 * Tests use it, or a port nothing listens on, instead of a shared Mailpit,
 * so they can make delivery fail and recover without touching anyone else's
 * mail.
 */
export interface FakeSmtp {
  port: number;
  messages: Array<{ from: string; to: string[]; data: string }>;
  close: () => Promise<void>;
}

export async function startFakeSmtp(port = 0): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake-smtp ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '' };
          reply('250 OK queued');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 fake-smtp');
        else if (verb === 'MAIL') {
          current.from = line.slice(10).trim();
          reply('250 OK');
        } else if (verb === 'RCPT') {
          current.to.push(line.slice(8).trim());
          reply('250 OK');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') reply('250 OK');
        else reply('502 Command not implemented');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A local port nothing listens on, so a connection to it is refused at once. */
export async function refusingPort(): Promise<number> {
  const probe = await startFakeSmtp();
  await probe.close();
  return probe.port;
}
