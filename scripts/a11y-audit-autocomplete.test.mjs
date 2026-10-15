import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateAutocomplete,
  expectedPurposes,
  INPUT_PURPOSES,
  parseAutocomplete,
} from './a11y-audit/lib/autocomplete.mjs';

test('the purposes are the HTML autofill field names, which include every 1.3.5 input purpose', () => {
  // The same 44 stand-alone and 10 telephone and email names axe validates against.
  assert.equal(INPUT_PURPOSES.length, 54);
  for (const token of ['email', 'username', 'current-password', 'new-password', 'one-time-code']) {
    assert.ok(INPUT_PURPOSES.includes(token), token);
  }
});

test('parsing accepts one purpose with the optional section, address and contact tokens', () => {
  assert.deepEqual(parseAutocomplete('email'), { valid: true, purpose: 'email' });
  assert.deepEqual(parseAutocomplete('  Current-Password '), {
    valid: true,
    purpose: 'current-password',
  });
  assert.deepEqual(parseAutocomplete('section-login username'), {
    valid: true,
    purpose: 'username',
  });
  assert.deepEqual(parseAutocomplete('shipping home tel'), { valid: true, purpose: 'tel' });
  assert.deepEqual(parseAutocomplete('off'), { valid: true, purpose: null });
  assert.deepEqual(parseAutocomplete(''), { valid: false, purpose: null, empty: true });
  assert.equal(parseAutocomplete('e-mail').valid, false);
  assert.equal(parseAutocomplete('email email').valid, false);
  assert.equal(parseAutocomplete('username webauthn').valid, true);
});

test('what a field is for is read from its type, name and label, never from its position', () => {
  assert.deepEqual(expectedPurposes({ type: 'email', label: 'Email' }), ['email', 'username']);
  assert.deepEqual(expectedPurposes({ type: 'password', label: 'Password' }), [
    'current-password',
    'new-password',
  ]);
  assert.deepEqual(expectedPurposes({ type: 'text', label: 'Authentication code' }), [
    'one-time-code',
  ]);
  assert.deepEqual(expectedPurposes({ type: 'text', label: 'Your name' }), ['name', 'given-name']);
  assert.deepEqual(expectedPurposes({ type: 'tel', label: 'Phone' }), ['tel']);
  // No known purpose: nothing is demanded.
  assert.equal(expectedPurposes({ type: 'text', label: 'Group name' }), null);
  assert.equal(expectedPurposes({ type: 'search', label: 'Search' }), null);
});

test('a missing, wrong or invalid token is a finding; a right one is not', () => {
  const findings = evaluateAutocomplete([
    { id: 'ok-email', type: 'email', label: 'Email', autocomplete: 'username' },
    { id: 'ok-pw', type: 'password', label: 'Password', autocomplete: 'current-password' },
    { id: 'no-token', type: 'email', label: 'Email', autocomplete: '' },
    { id: 'off', type: 'password', label: 'Password', autocomplete: 'off' },
    { id: 'wrong', type: 'email', label: 'Email', autocomplete: 'name' },
    { id: 'typo', type: 'password', label: 'Password', autocomplete: 'curent-password' },
    { id: 'code', type: 'text', label: 'Authentication code', autocomplete: 'one-time-code' },
    { id: 'unrelated', type: 'text', label: 'Group name', autocomplete: '' },
  ]);
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.problem]),
    [
      ['no-token', 'missing'],
      ['off', 'missing'],
      ['wrong', 'wrong-purpose'],
      ['typo', 'invalid'],
    ],
  );
});
