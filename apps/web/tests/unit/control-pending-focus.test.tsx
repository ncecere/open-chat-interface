// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, type FormEvent, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Input, Textarea } from '../../src/components/ui/input';
import { Select } from '../../src/components/ui/select';
import { Switch } from '../../src/components/ui/switch';

/**
 * #292: the #269 fix kept focus on a busy Button, but a switch that saves on
 * toggle (Settings › Memory's "Use memory", the admin switches), a select that
 * saves on change (a user's role) and a field whose Enter submits its form
 * still disabled themselves while saving and dropped focus to the body. The
 * real controls, a real QueryClient and mutations; only the browser's focus
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
    const active = document.activeElement as HTMLButtonElement | null;
    if (!active || !('disabled' in active) || !active.disabled) return;
    active.disabled = false;
    active.blur();
    active.disabled = true;
  });
  fixup.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
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

/** Like Settings › Memory's "Use memory": saves on toggle, disabled while saving. */
function UseMemory({ run }: { run: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(false);
  const toggle = useMutation({ mutationFn: run });
  return (
    <>
      <Switch
        aria-label="Use memory"
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={(next) => {
          setEnabled(next);
          toggle.mutate();
        }}
      />
      <a href="#next">Next</a>
    </>
  );
}

/** Like the admin's "Role for …": saves on change, disabled while saving. */
function RoleSelect({ run }: { run: () => Promise<void> }) {
  const [role, setRole] = useState('member');
  const change = useMutation({ mutationFn: run });
  return (
    <Select
      aria-label="Role for t.herrera@example.edu"
      value={role}
      onChange={(next) => {
        setRole(next);
        change.mutate();
      }}
      options={[
        { value: 'member', label: 'Member' },
        { value: 'admin', label: 'Admin' },
        { value: 'viewer', label: 'Viewer' },
      ]}
      disabled={change.isPending}
    />
  );
}

/** Like the admin forms: every field disabled while the form saves. */
function SaveForm({ run, multiline }: { run: () => Promise<void>; multiline?: boolean }) {
  const [value, setValue] = useState('5');
  const save = useMutation({ mutationFn: run });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const field = {
    'aria-label': 'Maximum results',
    value,
    disabled: save.isPending,
    onChange: (event: { target: { value: string } }) => setValue(event.target.value),
  };
  return (
    <form onSubmit={submit}>
      {multiline ? <Textarea {...field} /> : <Input {...field} />}
      <button type="submit" disabled={save.isPending}>
        Save
      </button>
    </form>
  );
}

async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const byRole = (role: string) => document.querySelector<HTMLElement>(`[role="${role}"]`)!;

describe('Switch disabled while it saves (#292)', () => {
  const control = () => byRole('switch') as HTMLButtonElement;

  it('keeps focus and announces the new state while it saves and after', async () => {
    const { state, run } = request();
    await render(<UseMemory run={run} />);
    control().focus();
    await act(async () => control().click());
    await settle();

    expect(document.activeElement).toBe(control());
    expect(control().getAttribute('aria-checked')).toBe('true');
    expect(control().getAttribute('aria-disabled')).toBe('true');

    await act(async () => state.finish());
    await settle();
    expect(document.activeElement).toBe(control());
    expect(control().disabled).toBe(false);
    expect(control().hasAttribute('aria-disabled')).toBe(false);
  });

  it('cannot be toggled again while it saves', async () => {
    const { state, run } = request();
    await render(<UseMemory run={run} />);
    control().focus();
    await act(async () => control().click());
    await settle();
    await act(async () => control().click());
    await settle();
    expect(control().getAttribute('aria-checked')).toBe('true');
    expect(state.calls).toBe(1);
  });

  it('is natively disabled once focus leaves, or when disabled without focus', async () => {
    const { run } = request();
    await render(<UseMemory run={run} />);
    control().focus();
    await act(async () => control().click());
    await settle();
    await act(async () => container.querySelector('a')!.focus());
    expect(control().disabled).toBe(true);
    expect(control().hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('Select disabled while it saves (#292)', () => {
  const trigger = () => byRole('combobox') as HTMLButtonElement;
  const option = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) => element.textContent === label,
    )!;

  it('returns focus to the trigger after a choice, and keeps it while it saves', async () => {
    const { state, run } = request();
    await render(<RoleSelect run={run} />);
    trigger().focus();
    await act(async () => trigger().click());
    await settle();
    await act(async () => option('Admin').focus());
    await act(async () => option('Admin').click());
    await settle();

    expect(state.calls).toBe(1);
    expect(trigger().textContent).toContain('Admin');
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-disabled')).toBe('true');

    // It does not open again while it saves.
    await act(async () => trigger().click());
    await settle();
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => state.finish());
    await settle();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().disabled).toBe(false);
    expect(trigger().hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('Fields disabled while their form saves (#292)', () => {
  for (const multiline of [false, true]) {
    const name = multiline ? 'Textarea' : 'Input';
    it(`${name}: keeps focus, is read-only meanwhile, and Enter does not submit again`, async () => {
      const { state, run } = request();
      await render(<SaveForm run={run} multiline={multiline} />);
      const field = () => container.querySelector<HTMLInputElement>('input, textarea')!;
      field().focus();
      await act(async () => container.querySelector('form')!.requestSubmit());
      await settle();

      expect(document.activeElement).toBe(field());
      expect(field().readOnly).toBe(true);
      expect(field().getAttribute('aria-disabled')).toBe('true');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      await act(async () => field().dispatchEvent(enter));
      expect(enter.defaultPrevented).toBe(true);
      expect(state.calls).toBe(1);

      await act(async () => state.finish());
      await settle();
      expect(document.activeElement).toBe(field());
      expect(field().disabled).toBe(false);
      expect(field().readOnly).toBe(false);
      expect(field().hasAttribute('aria-disabled')).toBe(false);
    });
  }
});
