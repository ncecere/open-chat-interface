// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, type FormEvent, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Button } from '../../src/components/ui/button';

/**
 * #269: buttons that disable themselves while their request runs
 * (`disabled={mutation.isPending}`) dropped keyboard focus to the body. The
 * real Button, a real QueryClient and mutation; only the browser's focus
 * fixup is emulated, which happy-dom lacks.
 */

let container: HTMLDivElement;
let root: Root;
let fixup: MutationObserver;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // Browsers blur a focused control the moment it becomes disabled; happy-dom
  // keeps it, and will not blur a disabled control, so that is done here.
  fixup = new MutationObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.disabled) return;
    active.disabled = false;
    active.blur();
    active.disabled = true;
  });
  fixup.observe(container, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
});
afterEach(async () => {
  fixup.disconnect();
  await act(async () => root.unmount());
  container.remove();
});

/** A request the test finishes by hand, counting how often it started. */
function request() {
  const state = { calls: 0, finish: () => {} };
  const run = () =>
    new Promise<void>((resolve) => {
      state.calls += 1;
      state.finish = resolve;
    });
  return { state, run };
}

function TestSearch({ run }: { run: () => Promise<void> }) {
  const test = useMutation({ mutationFn: run });
  return (
    <>
      <Button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? 'Testing…' : 'Test search'}
      </Button>
      <a href="#next">Next</a>
    </>
  );
}

/** Like Settings › Memory's Add: disabled while saving and once the box empties. */
function AddForm({ run }: { run: () => Promise<void> }) {
  const [draft, setDraft] = useState('A memory');
  const add = useMutation({ mutationFn: run });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(undefined, { onSuccess: () => setDraft('') });
  };
  return (
    <form onSubmit={submit}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" disabled={add.isPending || draft.length === 0}>
        Add
      </Button>
    </form>
  );
}

async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
}

const button = () => container.querySelector('button')!;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe('Button disabled while it has focus (#269)', () => {
  it('keeps focus while its request runs and after it finishes', async () => {
    const { state, run } = request();
    await render(<TestSearch run={run} />);
    button().focus();
    await act(async () => button().click());
    await settle();

    expect(button().textContent).toBe('Testing…');
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute('aria-disabled')).toBe('true');

    await act(async () => state.finish());
    await settle();
    expect(button().textContent).toBe('Test search');
    expect(document.activeElement).toBe(button());
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute('aria-disabled')).toBe(false);
  });

  it('cannot be pressed again while its request runs', async () => {
    const { state, run } = request();
    await render(<TestSearch run={run} />);
    button().focus();
    await act(async () => button().click());
    await settle();
    await act(async () => button().click());
    await act(async () => button().click());
    await settle();
    expect(state.calls).toBe(1);
  });

  it('becomes natively disabled once focus leaves', async () => {
    const { run } = request();
    await render(<TestSearch run={run} />);
    button().focus();
    await act(async () => button().click());
    await settle();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await act(async () => container.querySelector('a')!.focus());
    expect(button().disabled).toBe(true);
    expect(button().hasAttribute('aria-disabled')).toBe(false);
  });

  it('is natively disabled when it is disabled without focus', async () => {
    const { run } = request();
    await render(<TestSearch run={run} />);
    await act(async () => button().click());
    await settle();
    expect(button().textContent).toBe('Testing…');
    expect(button().disabled).toBe(true);
  });

  it('keeps focus on a submit button that the cleared form disables, and does not submit twice', async () => {
    const { state, run } = request();
    await render(<AddForm run={run} />);
    button().focus();
    await act(async () => button().click());
    await settle();
    expect(document.activeElement).toBe(button());
    // A second press while saving does not submit the form again.
    await act(async () => button().click());
    expect(state.calls).toBe(1);

    await act(async () => state.finish());
    await settle();
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await act(async () => button().click());
    expect(state.calls).toBe(1);
  });
});
