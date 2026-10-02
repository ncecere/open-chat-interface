// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectSearchNote, projectSearchOf } from '../../src/components/chat/project-search-note';

function reply(parts: unknown[]): UIMessage {
  return { id: 'assistant-1', role: 'assistant', parts: parts as UIMessage['parts'] };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

async function render(message: UIMessage) {
  await act(() => root.render(<ProjectSearchNote message={message} />));
  return container.querySelector('[role="note"]');
}

describe('project search note', () => {
  it('names the searched files and how many passages came from each', async () => {
    const note = await render(
      reply([
        { type: 'text', text: 'The code is in the handbook.' },
        {
          type: 'data-project-search',
          id: 'project-search-1',
          data: {
            mode: 'search',
            files: [
              { name: 'handbook.pdf', passages: 2 },
              { name: 'notes.txt', passages: 1 },
            ],
          },
        },
      ]),
    );
    expect(note?.textContent).toBe(
      'Searched project files. Used passages from handbook.pdf (2 passages), notes.txt (1 passage).',
    );
    expect(note?.getAttribute('data-project-search')).toBe('search');
  });

  it('explains when the opening passages were used because nothing matched', async () => {
    const note = await render(
      reply([
        {
          type: 'data-project-search',
          data: { mode: 'opening', files: [{ name: 'a.txt', passages: 1 }] },
        },
      ]),
    );
    expect(note?.textContent).toContain('nothing matched');
    expect(note?.textContent).toContain('opening passages of a.txt (1 passage).');
  });

  it('renders nothing without a valid part', async () => {
    expect(await render(reply([{ type: 'text', text: 'Plain reply' }]))).toBeNull();
    for (const data of [
      null,
      { mode: 'search', files: [] },
      { mode: 'other', files: [{ name: 'a.txt', passages: 1 }] },
      { mode: 'search', files: [{ name: 'a.txt', passages: 0 }] },
      { mode: 'search', files: [{ name: 42, passages: 1 }] },
    ]) {
      const message = reply([{ type: 'data-project-search', data }]);
      expect(projectSearchOf(message)).toBeNull();
      expect(await render(message)).toBeNull();
    }
  });
});
