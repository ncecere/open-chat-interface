// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResendVerification } from '../../src/components/auth/resend-verification';

const { sendVerificationEmail } = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));
vi.mock('../../src/lib/auth-client', () => ({ authClient: { sendVerificationEmail } }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  root = createRoot(container);
  sendVerificationEmail.mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
});

it('requests verification for the address without claiming confirmed delivery', async () => {
  sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
  await act(() => root.render(<ResendVerification email=" pending@example.test " />));
  await act(async () => container.querySelector('button')!.click());
  expect(sendVerificationEmail).toHaveBeenCalledWith({
    email: 'pending@example.test',
    callbackURL: '/',
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'If this address needs verification',
  );
  expect(container.textContent).toContain('contact an administrator');
});

it.each(['response', 'network'])('shows a retryable generic error on %s failure', async (kind) => {
  if (kind === 'response')
    sendVerificationEmail.mockResolvedValue({ error: { message: 'private transport details' } });
  else sendVerificationEmail.mockRejectedValue(new Error('private transport details'));
  await act(() => root.render(<ResendVerification email="pending@example.test" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not request');
  expect(container.textContent).not.toContain('private transport details');
  expect(container.querySelector('button')?.disabled).toBe(false);
  sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it('prevents duplicate sends while a request is pending', async () => {
  let finish!: (result: { error: null }) => void;
  sendVerificationEmail.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(() => root.render(<ResendVerification email="pending@example.test" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')?.disabled).toBe(true);
  await act(async () => container.querySelector('button')!.click());
  expect(sendVerificationEmail).toHaveBeenCalledOnce();
  await act(async () => finish({ error: null }));
  // Not again at once: the API would skip a second email within the minute (#330).
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.textContent).toContain('You can ask again in a minute.');
});

it('offers another request a minute after the last one (#330)', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
    await act(() => root.render(<ResendVerification email="pending@example.test" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('button')?.disabled).toBe(false);
    await act(async () => container.querySelector('button')!.click());
    expect(sendVerificationEmail).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
