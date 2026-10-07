import { updateInstanceSettingsSchema, updateRetentionSettingsSchema } from '@oci/shared';
import { describe, expect, it } from 'vitest';

const accepts = (input: unknown) => updateInstanceSettingsSchema.safeParse(input).success;

/** The QA walk saved each of the refused values below through the settings API. */
describe('instance settings refuse what the forms would', () => {
  it('stores only an image address as the sign-in logo', () => {
    expect(accepts({ logoUrl: 'javascript:alert(1)' })).toBe(false);
    expect(accepts({ logoUrl: 'data:image/svg+xml,<svg/>' })).toBe(false);
    expect(accepts({ logoUrl: '//evil.example/logo.png' })).toBe(false);
    expect(accepts({ logoUrl: 'https://cdn.example.edu/logo.png' })).toBe(true);
    expect(accepts({ logoUrl: '/api/branding/logo' })).toBe(true);
    expect(accepts({ logoUrl: null })).toBe(true);
  });

  it('keeps SMTP to a real port and from address', () => {
    expect(accepts({ smtp: { port: 99_999 } })).toBe(false);
    expect(accepts({ smtp: { port: 0 } })).toBe(false);
    expect(accepts({ smtp: { fromAddress: 'not-an-email' } })).toBe(false);
    expect(accepts({ smtp: { port: 587, fromAddress: 'oci@northbrook.edu' } })).toBe(true);
    expect(accepts({ smtp: { fromAddress: 'Help Desk <help@northbrook.edu>' } })).toBe(true);
  });

  it('refuses keys it does not know instead of answering ok', () => {
    expect(accepts({ nonsenseKey: 5 })).toBe(false);
    expect(accepts({ appName: 'Walk', nonsenseKey: 5 })).toBe(false);
  });

  it('accepts only real time zones for reporting', () => {
    const zone = (displayTimezone: string) =>
      updateRetentionSettingsSchema.safeParse({ displayTimezone }).success;
    expect(zone('Mars/Olympus')).toBe(false);
    expect(zone('Europe/London')).toBe(true);
    expect(zone('America/New_York')).toBe(true);
    expect(zone('UTC')).toBe(true);
  });
});
