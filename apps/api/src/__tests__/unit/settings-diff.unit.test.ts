import { describe, expect, it } from 'vitest';
import { diffSettings, redactSecrets } from '../../services/settings-diff.js';

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

  it('compares nested objects whole', () => {
    const changes = diffSettings(
      { features: { branching: false } },
      { features: { branching: true } },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.after).toEqual({ branching: true });
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
    const after = changes[0]?.after as Record<string, unknown> | undefined;
    expect(after?.host).toBe('new.example.com');
    expect(after?.password).toBe('[set]');
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
    const changes = diffSettings({ search: snapshot }, { search: { provider: 'serpapi' } });
    expect(changes[0]?.before).toEqual({ provider: 'searxng', encryptedApiKey: '[unset]' });
  });
});
