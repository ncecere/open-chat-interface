// @vitest-environment happy-dom
import type { ClassificationClass } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationLabels } from '../../src/components/chat/conversation-labels';
import { DataClassLabels } from '../../src/components/classification/data-class-labels';
import { ProjectLabelsSection } from '../../src/routes/projects/project-labels';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const readOnly = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/lib/read-only', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/read-only')>()),
  useReadOnlyLock: () => ({
    locked: readOnly.active,
    title: readOnly.active ? 'Changes are paused while the instance is read-only.' : undefined,
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  readOnly.active = false;
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
/** Opens "Add label" the way the keyboard does: Radix menus open on Enter, Space or ArrowDown. */
async function openAddMenu() {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Add label"]')!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
  await settle();
}
const chips = () =>
  [...container.querySelectorAll('[data-class-chip]')].map((node) => node.textContent);
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name,
  );

const person: ClassificationClass = {
  id: 'c-person',
  name: 'Health data',
  reasons: ['person'],
  removable: true,
};
const project: ClassificationClass = {
  id: 'c-project',
  name: 'Student records',
  reasons: ['project'],
  removable: false,
};
const connector: ClassificationClass = {
  id: 'c-connector',
  name: 'Payroll',
  reasons: ['connector'],
  connectorNames: ['SIS'],
  removable: false,
};

describe('DataClassLabels', () => {
  const render = (props: Partial<Parameters<typeof DataClassLabels>[0]> = {}) =>
    act(() =>
      root.render(
        <DataClassLabels
          scope="thread"
          classes={[person, project, connector]}
          addable={[{ id: 'c-new', name: 'Research data' }]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          {...props}
        />,
      ),
    );

  it('shows each class with its reason', async () => {
    await render();
    expect(chips()).toEqual([
      'Health data· added by you',
      'Student records· from the project. Student records comes from the project. Change the project’s labels to remove it.',
      'Payroll· from the SIS connector. Payroll comes from a connector this conversation used, so it stays as long as the connector carries it.',
    ]);
  });

  it('gives only the labels the person added a remove button', async () => {
    const onRemove = vi.fn();
    await render({ onRemove });
    const removers = [...container.querySelectorAll('button[aria-label^="Remove the"]')];
    expect(removers.map((node) => node.getAttribute('aria-label'))).toEqual([
      'Remove the Health data label',
    ]);
    await act(() => (removers[0] as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledWith('c-person');
  });

  it('explains, once, why the others have none', async () => {
    await render();
    expect(container.textContent).toContain(
      'Labels that come from the project or a connector cannot be removed here',
    );
    await render({ classes: [person] });
    expect(container.textContent).not.toContain('cannot be removed here');
  });

  it('adds a label from the menu of classes not yet carried', async () => {
    const onAdd = vi.fn();
    await render({ onAdd });
    await openAddMenu();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((node) => node.textContent)).toEqual(['Research data']);
    await act(() => (items[0] as HTMLElement).click());
    expect(onAdd).toHaveBeenCalledWith('c-new');
  });

  it('offers no Add label when there is nothing to add', async () => {
    await render({ addable: [] });
    expect(button('Add label')).toBeUndefined();
  });

  it('says a failed change in words', async () => {
    await render({ error: new Error('boom') });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The label could not be changed.',
    );
  });

  it('on a project, a label an administrator set is locked and explained', async () => {
    await render({
      scope: 'project',
      classes: [
        { ...project, reasons: ['project'], locked: true },
        { ...person, locked: false },
      ],
    });
    expect(container.querySelectorAll('button[aria-label^="Remove the"]')).toHaveLength(1);
    expect(chips()[0]).toContain('set by an administrator');
    expect(chips()[0]).toContain('only an administrator can remove it');
    expect(container.textContent).toContain('stay until an administrator removes them');
  });

  it('is off while the instance is read-only, with the reason', async () => {
    readOnly.active = true;
    await render();
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove the"]')!;
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.title).toContain('read-only');
    expect(
      container.querySelector('button[aria-label="Add label"]')!.getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

function renderWithQueries(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

describe('ConversationLabels', () => {
  const on = (classes: ClassificationClass[] = [project, person]) => ({
    mode: 'block' as const,
    classes,
    models: [],
  });

  beforeEach(() => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/data-classes')
        return {
          classes: [
            { id: 'c-project', name: 'Student records' },
            { id: 'c-new', name: 'Research data' },
          ],
        };
      throw new Error(`unexpected ${path}`);
    });
  });

  it('renders nothing, and asks for nothing, while classification is off or unknown', async () => {
    await renderWithQueries(<ConversationLabels threadId="t1" classification={undefined} />);
    await renderWithQueries(
      <ConversationLabels
        threadId="t1"
        classification={{ mode: 'off', classes: [], models: [] }}
      />,
    );
    await settle();
    expect(container.innerHTML).toBe('');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows the chips and offers the classes not yet carried', async () => {
    await renderWithQueries(<ConversationLabels threadId="t1" classification={on()} />);
    await settle();
    expect(chips().map((text) => text?.split('·')[0])).toEqual(['Student records', 'Health data']);
    expect(api.get).toHaveBeenCalledWith('/data-classes');
  });

  it('adds a label with the person’s request, and removes one of theirs', async () => {
    api.post.mockResolvedValue({ classes: [] });
    api.delete.mockResolvedValue({ classes: [] });
    await renderWithQueries(<ConversationLabels threadId="t 1" classification={on()} />);
    await settle();
    await openAddMenu();
    await act(() => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
    await settle();
    expect(api.post).toHaveBeenCalledWith('/threads/t%201/data-classes', { classId: 'c-new' });

    await act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Remove the Health data label"]')!
        .click(),
    );
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/threads/t%201/data-classes/c-person');
  });

  it('says why a change failed', async () => {
    api.post.mockRejectedValue(new Error('no'));
    await renderWithQueries(<ConversationLabels threadId="t1" classification={on([person])} />);
    await settle();
    await openAddMenu();
    await act(() => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The label could not be changed.',
    );
  });

  it('renders nothing when nothing is carried and there is nothing to add', async () => {
    api.get.mockResolvedValue({ classes: [] });
    await renderWithQueries(<ConversationLabels threadId="t1" classification={on([])} />);
    await settle();
    expect(container.innerHTML).toBe('');
  });
});

describe('ProjectLabelsSection', () => {
  it('sets the whole list, keeping an administrator’s locked label', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/classification?projectId='))
        return {
          mode: 'block',
          classes: [{ ...project, locked: true }],
          models: [],
        };
      if (path === '/data-classes')
        return {
          classes: [
            { id: 'c-project', name: 'Student records' },
            { id: 'c-new', name: 'Research data' },
          ],
        };
      throw new Error(`unexpected ${path}`);
    });
    api.put.mockResolvedValue({ classes: [] });
    await renderWithQueries(<ProjectLabelsSection projectId="p1" />);
    await settle();
    await settle();
    expect(container.querySelector('h2')?.textContent).toBe('Data classes');
    // Locked: no remove button, and a note.
    expect(container.querySelector('button[aria-label^="Remove the"]')).toBeNull();
    expect(chips()[0]).toContain('set by an administrator');

    await openAddMenu();
    await act(() => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
    await settle();
    expect(api.put).toHaveBeenCalledWith('/projects/p1/data-classes', {
      classIds: ['c-project', 'c-new'],
    });
  });

  it('is not on the page while classification is off', async () => {
    api.get.mockResolvedValue({ mode: 'off', classes: [], models: [] });
    await renderWithQueries(<ProjectLabelsSection projectId="p1" />);
    await settle();
    expect(container.innerHTML).toBe('');
  });
});
