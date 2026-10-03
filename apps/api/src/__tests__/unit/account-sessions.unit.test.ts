import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ db: {} }));

const { maskIpAddress } = await import('../../services/account-sessions.js');

describe('Settings → Account → Devices addresses', () => {
  it.each([
    ['203.0.113.42', '203.0.113.x'],
    ['::ffff:198.51.100.7', '198.51.100.x'],
    ['2001:db8:85a3:0:0:8a2e:370:7334', '2001:db8:85a3:…'],
    ['  10.0.0.1 ', '10.0.0.x'],
  ])('shortens %s to %s', (input, expected) => {
    expect(maskIpAddress(input)).toBe(expected);
  });

  it.each([null, '', 'not an address', '::'])('shows nothing for %j', (input) => {
    expect(maskIpAddress(input)).toBeNull();
  });
});
