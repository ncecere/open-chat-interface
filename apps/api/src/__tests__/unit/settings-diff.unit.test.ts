import { describe, expect, it } from 'vitest';
import { diffSettings, diffUpdate, redactSecrets } from '../../services/settings-diff.js';

describe('diffSettings', () => {
  it('records what a value was as well as what it became', () => {
    const changes = diffSettings({ registrationMode: 'open' }, { registrationMode: 'closed' });
    expect(changes).toEqual([{ key: 'registrationMode', before: 'open', after: 'closed' }]);
  });

  it('ignores a key submitted with its existing value', () => {
    expect(diffSettings({ appName: 'OCI' }, { appName: 'OCI' })).toEqual([]);
  });

  it('ignores keys the patch does not mention', () => {
    const changes = diffSettings({ appName: 'OCI', registrationMode: 'open' }, { appName: 'Chat' });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.key).toBe('appName');
  });

  it('never records a secret value, only whether one is set', () => {
    const changes = diffSettings({ smtpPassword: 'old-secret' }, { smtpPassword: 'new-secret' });
    expect(changes).toEqual([{ key: 'smtpPassword', before: '[set]', after: '[set]' }]);
    expect(JSON.stringify(changes)).not.toContain('secret-');
  });

  it('redacts a token but records a token count (#221)', () => {
    expect(diffSettings({ accessToken: 'a' }, { accessToken: 'b' })).toEqual([
      { key: 'accessToken', before: '[set]', after: '[set]' },
    ]);
    expect(diffSettings({ maxOutputTokens: null }, { maxOutputTokens: 64_000 })).toEqual([
      { key: 'maxOutputTokens', before: null, after: 64_000 },
    ]);
  });

  it('distinguishes clearing a secret from replacing it', () => {
    expect(diffSettings({ apiKey: 'k' }, { apiKey: '' })).toEqual([
      { key: 'apiKey', before: '[set]', after: '[unset]' },
    ]);
  });

  it('compares a nested object field by field, each change named by its path (#344)', () => {
    const changes = diffSettings(
      { features: { branching: false, memory: true } },
      { features: { branching: true, memory: true } },
    );
    expect(changes).toEqual([{ key: 'features.branching', before: false, after: true }]);
  });
});

describe('diffSettings: a nested branch sent in part (#344)', () => {
  // What the Storage form sends against what is stored: before the fix `before`
  // was the whole stored branch and `after` only the field sent.
  const stored = {
    storage: {
      driver: 's3',
      maxFileBytes: 26_214_400,
      maxFilesPerMessage: 7,
      allowedMimeTypes: ['image/png', 'application/pdf'],
      s3: { bucket: 'oci', region: 'us-east-1', encryptedSecretAccessKey: '[set]' },
    },
    smtp: { host: 'mail.test', port: 1026, encryptedPassword: '[unset]' },
  };

  it('records the one field that changed with its own before, not the stored branch', () => {
    expect(diffSettings(stored, { storage: { maxFilesPerMessage: 10 } })).toEqual([
      { key: 'storage.maxFilesPerMessage', before: 7, after: 10 },
    ]);
    expect(diffSettings(stored, { smtp: { host: 'mail.test', port: 1025 } })).toEqual([
      { key: 'smtp.port', before: 1026, after: 1025 },
    ]);
  });

  it('reaches fields nested twice, and compares a list as a whole', () => {
    expect(
      diffSettings(stored, {
        storage: { s3: { bucket: 'other', region: 'us-east-1' }, allowedMimeTypes: ['image/png'] },
      }),
    ).toEqual([
      { key: 'storage.s3.bucket', before: 'oci', after: 'other' },
      {
        key: 'storage.allowedMimeTypes',
        before: ['image/png', 'application/pdf'],
        after: ['image/png'],
      },
    ]);
  });

  it('shows a field with nothing stored as changing from null', () => {
    expect(diffSettings({}, { smtp: { fromAddress: 'oci@example.test' } })).toEqual([
      { key: 'smtp.fromAddress', before: null, after: 'oci@example.test' },
    ]);
  });

  it('compares a typed secret with the stored encrypted one, by presence only', () => {
    const changes = diffSettings(stored, {
      smtp: { password: 'SuperSecret123' },
      storage: { s3: { secretAccessKey: 'AnotherSecret456' } },
    });
    expect(changes).toEqual([
      { key: 'smtp.password', before: '[unset]', after: '[set]' },
      { key: 'storage.s3.secretAccessKey', before: '[set]', after: '[set]' },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/SuperSecret123|AnotherSecret456/);
    // Clearing a stored secret, and sending nothing to one that had none.
    expect(diffSettings(stored, { storage: { s3: { secretAccessKey: '' } } })).toEqual([
      { key: 'storage.s3.secretAccessKey', before: '[set]', after: '[unset]' },
    ]);
    expect(diffSettings(stored, { smtp: { password: '' } })).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('strips secret-looking values at any depth', () => {
    const redacted = redactSecrets({
      driver: 's3',
      s3: { bucket: 'oci', encryptedSecretKey: 'aaa', region: 'us-east-1' },
    }) as Record<string, Record<string, unknown>>;

    expect(redacted.s3?.bucket).toBe('oci');
    expect(redacted.s3?.encryptedSecretKey).toBe('[set]');
    expect(JSON.stringify(redacted)).not.toContain('aaa');
  });

  it('leaves an unset secret distinguishable from a set one', () => {
    const redacted = redactSecrets({ password: null }) as Record<string, unknown>;
    expect(redacted.password).toBe('[unset]');
  });
});

describe('diffSettings with nested secrets', () => {
  it('redacts a secret nested inside a changed branch', () => {
    // The key-level check alone misses this: `smtp` is not itself a secret
    // name, so an unredacted patch would carry the password straight into the
    // audit log. This was a real leak before it was caught.
    const changes = diffSettings(
      { smtp: { host: 'old.example.com', password: 'old-pass' } },
      { smtp: { host: 'new.example.com', password: 'SuperSecret123' } },
    );

    expect(JSON.stringify(changes)).not.toContain('SuperSecret123');
    expect(JSON.stringify(changes)).not.toContain('old-pass');
    // Field by field (#344): the host changed, and the password by presence.
    expect(changes).toEqual([
      { key: 'smtp.host', before: 'old.example.com', after: 'new.example.com' },
      { key: 'smtp.password', before: '[set]', after: '[set]' },
    ]);
  });

  it('redacts a nested secret on the previous value too', () => {
    const changes = diffSettings(
      { search: { provider: 'brave', encryptedApiKey: 'stored-key' } },
      { search: { provider: 'tavily' } },
    );
    expect(JSON.stringify(changes)).not.toContain('stored-key');
  });

  it('keeps an absent secret absent when redacted twice', () => {
    // The settings route redacts its snapshot, and the diff redacts again.
    const snapshot = redactSecrets({ provider: 'searxng', encryptedApiKey: null });
    expect(redactSecrets(snapshot)).toEqual({ provider: 'searxng', encryptedApiKey: '[unset]' });
    const changes = diffSettings(
      { search: snapshot },
      { search: { provider: 'serpapi', apiKey: '' } },
    );
    expect(changes).toEqual([{ key: 'search.provider', before: 'searxng', after: 'serpapi' }]);
  });
});

describe('diffUpdate (#258)', () => {
  it('names a nested change by its path and leaves the rest out', () => {
    const before = { roles: { user: { chat: 20, upload: 10 }, admin: { chat: 60 } }, auth: 10 };
    const after = { roles: { user: { chat: 7, upload: 10 }, admin: { chat: 60 } }, auth: 1000 };
    expect(diffUpdate(before, after)).toEqual([
      { key: 'roles.user.chat', before: 20, after: 7 },
      { key: 'auth', before: 10, after: 1000 },
    ]);
  });

  it('compares only the keys asked for, dates as ISO strings, secrets by presence', () => {
    const before = {
      url: 'https://old.example.com',
      endsAt: null,
      encryptedSecret: 'cipher',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const after = {
      url: 'https://new.example.com',
      endsAt: new Date('2026-10-07T10:00:00Z'),
      encryptedSecret: 'other',
      updatedAt: new Date('2026-10-06T00:00:00Z'),
    };
    expect(diffUpdate(before, after, ['url', 'endsAt', 'encryptedSecret'])).toEqual([
      { key: 'url', before: 'https://old.example.com', after: 'https://new.example.com' },
      { key: 'endsAt', before: null, after: '2026-10-07T10:00:00.000Z' },
      { key: 'encryptedSecret', before: '[set]', after: '[set]' },
    ]);
  });

  it('records a nested field that is gone as becoming null', () => {
    expect(
      diffUpdate({ claims: { email: 'mail', name: 'cn' } }, { claims: { email: 'mail' } }),
    ).toEqual([{ key: 'claims.name', before: 'cn', after: null }]);
  });
});
