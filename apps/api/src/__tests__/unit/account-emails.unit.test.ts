import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account emails (#78): the invitation says who sent it, the role and
 * when it expires; invitation, verification and reset carry an HTML
 * alternative with the link as a button; the usage report counts "1 message".
 */
const sent = vi.hoisted(() => [] as Array<{ to: string; text: string; html?: string }>);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; text: string; html?: string }) => {
        sent.push(mail);
        return { messageId: 'walk' };
      },
    }),
  },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({
    host: 'mail.example.test',
    port: 587,
    secure: false,
    fromAddress: 'oci@example.test',
    username: null,
    encryptedPassword: null,
  }),
}));
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Walk Instance' }));
vi.mock('../../db/index.js', () => ({ db: {} }));

const { sendInviteEmail, sendVerificationEmail, sendPasswordResetEmail, actionEmailHtml } =
  await import('../../services/email.js');
const { messageCount, modelLine, reportHeading } = await import('../../services/reports.js');

beforeEach(() => {
  sent.length = 0;
});

describe('account emails', () => {
  it('says who invited you, as what, and until when', async () => {
    await sendInviteEmail({
      to: 'new@example.edu',
      url: 'https://oci.example.edu/auth/accept-invite#token=t',
      inviter: 'Walk Admin',
      role: 'auditor',
      expiresAt: new Date('2026-10-12T09:00:00Z'),
    });
    const [mail] = sent;
    expect(mail?.text).toBe(
      [
        'Walk Admin has invited you to join Walk Instance as an auditor.',
        '',
        'Accept the invitation:',
        '',
        'https://oci.example.edu/auth/accept-invite#token=t',
        '',
        'The invitation expires on October 12, 2026 (UTC).',
      ].join('\n'),
    );
    expect(mail?.html).toContain('>Accept the invitation</a>');
    expect(mail?.html).toContain('href="https://oci.example.edu/auth/accept-invite#token=t"');

    await sendInviteEmail({ to: 'x@example.edu', url: 'https://x', expiresAt: null });
    expect(sent[1]?.text).toContain('The invitation does not expire.');
  });

  it('gives verification and reset an HTML version with the link as a button', async () => {
    await sendVerificationEmail({ to: 'a@example.edu', url: 'https://oci/verify?t=1' });
    await sendPasswordResetEmail({ to: 'a@example.edu', url: 'https://oci/reset?t=2' });
    expect(sent[0]?.html).toContain('>Verify email address</a>');
    expect(sent[1]?.html).toContain('>Choose a new password</a>');
    // The text part is unchanged for clients that prefer it.
    expect(sent[0]?.text).toContain('https://oci/verify?t=1');
  });

  it('escapes everything it puts into HTML', () => {
    const html = actionEmailHtml({
      paragraphs: ['<script>alert(1)</script> & "quotes"'],
      action: { label: 'Go', url: 'https://x/"><img src=x>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the usage report', () => {
  it('opens with "last 1 day", not "last 1 days" (#286)', () => {
    expect(reportHeading('OCI', 1)).toBe('OCI usage, last 1 day');
    expect(reportHeading('OCI', 30)).toBe('OCI usage, last 30 days');
  });

  it('counts one message as one message', () => {
    expect(messageCount(1)).toBe('1 message');
    expect(messageCount(0)).toBe('0 messages');
    expect(messageCount(1204)).toBe('1,204 messages');
  });

  it('gives an embeddings model its name and tokens, not its key and "0 messages" (#263)', () => {
    const usage = { modelSlug: 'gpt', displayName: 'GPT', messages: 1, tokens: 9, costMicros: 0 };
    expect(modelLine({ ...usage, kind: 'chat' })).toBe('GPT  1 message  $0.00');
    expect(
      modelLine({
        modelSlug: 'embedding:text-embedding-3-small',
        displayName: 'text-embedding-3-small',
        kind: 'embeddings',
        messages: 0,
        tokens: 247_300,
        costMicros: 0,
      }),
    ).toBe('text-embedding-3-small (embeddings)  247,300 tokens  $0.00');
  });
});
