// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Button } from '../../src/components/ui/button';
import { Switch } from '../../src/components/ui/switch';

/**
 * #357: in read-only mode the Settings controls that change something were
 * natively disabled with the reason only in a `title`. Tab skipped them, a
 * screen reader in forms mode never met the reason, and touch users never saw
 * a title. A locked control is aria-disabled instead: focusable, described by
 * the reason, and pressing it (Enter, Space or a tap) announces the reason in
 * a toast and does nothing else.
 */
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const REASON = 'Read-only for maintenance until about 8:46 PM EDT';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  toast.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const describedBy = (element: Element) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')
    .trim();

it('a locked Button can be focused, says why, and announces the reason when pressed', async () => {
  const onClick = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  await act(async () =>
    root.render(
      <form onSubmit={onSubmit}>
        <Button type="submit" locked={REASON} onClick={onClick} aria-describedby="extra">
          Edit name
        </Button>
        <p id="extra">Extra hint</p>
      </form>,
    ),
  );
  const control = container.querySelector('button')!;
  expect(control.disabled).toBe(false);
  expect(control.getAttribute('aria-disabled')).toBe('true');
  await act(async () => control.focus());
  expect(document.activeElement).toBe(control);
  // Described by the reason as well as what it already pointed at; its name is unchanged.
  expect(describedBy(control)).toBe(`Extra hint ${REASON}`);
  expect(control.textContent).toBe('Edit name');
  expect(control.title).toBe(REASON);

  await act(async () => control.click());
  expect(onClick).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(REASON, expect.objectContaining({ id: 'locked-control' }));
});

it('a Button with no reason is as before: enabled, or natively disabled', async () => {
  const onClick = vi.fn();
  await act(async () =>
    root.render(
      <>
        <Button onClick={onClick}>Save</Button>
        <Button disabled>Off</Button>
      </>,
    ),
  );
  const [save, off] = [...container.querySelectorAll('button')];
  expect(save!.getAttribute('aria-disabled')).toBeNull();
  expect(off!.disabled).toBe(true);
  await act(async () => save!.click());
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(toast).not.toHaveBeenCalled();
});

it('a locked Switch is focusable, described by the reason, and does not toggle', async () => {
  const onCheckedChange = vi.fn();
  await act(async () =>
    root.render(
      <Switch
        aria-label="Memory"
        checked={false}
        locked={REASON}
        onCheckedChange={onCheckedChange}
      />,
    ),
  );
  const control = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  expect(control.disabled).toBe(false);
  expect(control.getAttribute('aria-disabled')).toBe('true');
  expect(describedBy(control)).toBe(REASON);
  await act(async () => control.focus());
  expect(document.activeElement).toBe(control);
  await act(async () => control.click());
  expect(onCheckedChange).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(REASON, expect.objectContaining({ id: 'locked-control' }));
});
