// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bdiMessage } from '../../src/components/auth/bdi-message';
import { activateLocale, translate } from '../../src/lib/i18n/state';
import { secondStepProblem } from '../../src/lib/mfa';

beforeEach(async () => {
  await activateLocale('en');
});
afterEach(async () => {
  await activateLocale('en');
});

describe('a wait in the second step messages', () => {
  it('uses the plural of the language showing', async () => {
    await activateLocale('ar');
    // Arabic has a dual and a "few" form: one second, two, three to ten, eleven.
    expect(translate('auth.retry.seconds', { count: 1 })).toBe('ثانية واحدة');
    expect(translate('auth.retry.seconds', { count: 2 })).toBe('ثانيتين');
    expect(translate('auth.retry.seconds', { count: 5 })).toContain('ثوانٍ');
    expect(translate('auth.retry.seconds', { count: 11 })).toContain('ثانية');

    await activateLocale('es');
    expect(translate('auth.retry.minutes', { count: 1 })).toBe('1 minuto');
    expect(translate('auth.retry.minutes', { count: 15 })).toBe('15 minutos');
  });

  it('puts the wait into the lockout message in the language showing', async () => {
    await activateLocale('es');
    const problem = secondStepProblem(
      { code: 'TOO_MANY_REQUESTS', status: 429, retryAfter: 120 },
      'totp',
    );
    expect(problem.text).toContain('2 minutos');
    expect(problem.text).not.toMatch(/\bminutes?\b/);
  });
});

describe('bdiMessage', () => {
  it('isolates the value a person typed inside one translated sentence', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await activateLocale('ar');
    const nodes = bdiMessage(translate, 'auth.login.unverifiedSent', undefined, {
      email: 'pat@example.test',
    });
    await act(async () => createRoot(container).render(<p>{nodes}</p>));
    const bdi = container.querySelector('bdi');
    expect(bdi?.textContent).toBe('pat@example.test');
    expect(container.textContent).toContain('pat@example.test');
    expect(container.textContent).not.toContain('\uE000');
    container.remove();
  });
});
