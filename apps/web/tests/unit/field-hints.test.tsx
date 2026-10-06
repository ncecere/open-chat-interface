// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Field, invalidFieldProps } from '../../src/components/ui/field';
import { Input, Textarea } from '../../src/components/ui/input';
import { GroupedSelect, Select } from '../../src/components/ui/select';
import { Switch } from '../../src/components/ui/switch';
import { ResetPasswordPage } from '../../src/routes/auth/password-reset';
import { SignupPage } from '../../src/routes/auth/signup';

/**
 * #295: a field's hint ("Separate addresses with commas", "up to 20", "Use at
 * least 12 characters.") was a bare paragraph after its control, not tied to
 * it, so a screen reader announced the control with its name only. The real
 * Field and shared controls, and the real auth pages that build theirs by hand.
 */
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: {
      localAuthEnabled: true,
      registrationMode: 'open',
      smtpConfigured: true,
      ssoProviders: [],
      branding: {},
    },
    isLoading: false,
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
}

/** What a screen reader reads after the name: the text of every id in aria-describedby. */
function description(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
    .join(' | ');
}
const control = (id: string) => document.getElementById(id)!;
const noop = () => {};
const OPTIONS = [{ value: 'a', label: 'A' }];

describe('Field hints describe their control (#295)', () => {
  it('ties the hint to every shared control', async () => {
    await render(
      <>
        <Field label="Maximum results" htmlFor="max" hint="Up to 20.">
          <Input id="max" />
        </Field>
        <Field label="Recipients" htmlFor="to" hint="Separate addresses with commas.">
          <Textarea id="to" />
        </Field>
        <Field label="Window" htmlFor="window" hint="How far back the report looks.">
          <Select id="window" value="a" onChange={noop} options={OPTIONS} />
        </Field>
        <Field label="Model" htmlFor="model" hint="Grouped by provider.">
          <GroupedSelect
            id="model"
            value="a"
            onChange={noop}
            groups={[{ label: 'P', options: OPTIONS }]}
          />
        </Field>
        <Field label="Enabled" htmlFor="on" hint="Takes effect at once.">
          <Switch id="on" />
        </Field>
        <Field label="Plain" htmlFor="plain">
          <Input id="plain" />
        </Field>
      </>,
    );
    expect(description(control('max'))).toBe('Up to 20.');
    expect(description(control('to'))).toBe('Separate addresses with commas.');
    expect(description(control('window'))).toBe('How far back the report looks.');
    expect(description(control('model'))).toBe('Grouped by provider.');
    expect(description(control('on'))).toBe('Takes effect at once.');
    // No hint, nothing added.
    expect(control('plain').hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps the control’s own descriptions and error, then the hint', async () => {
    const error = 'Maximum results must be at most 20.';
    await render(
      <>
        <p id="badge">Set by the environment.</p>
        <Field label="Maximum results" htmlFor="max" hint="Up to 20." error={error}>
          <Input id="max" {...invalidFieldProps('max', error, 'badge')} />
        </Field>
      </>,
    );
    expect(control('max').getAttribute('aria-invalid')).toBe('true');
    expect(description(control('max'))).toBe(`Set by the environment. | ${error} | Up to 20.`);
  });

  it('ties the password rule to the field on the reset and sign-up pages', async () => {
    window.history.replaceState(null, '', '/auth/reset-password?token=abc');
    await render(<ResetPasswordPage />);
    expect(description(control('new-password'))).toBe('Use at least 12 characters.');

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<SignupPage />);
    expect(description(control('signup-password'))).toBe('Use at least 12 characters.');
  });
});
