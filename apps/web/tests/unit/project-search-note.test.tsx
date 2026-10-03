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

  it('says when passages were found by meaning as well as keywords', async () => {
    const note = await render(
      reply([
        {
          type: 'data-project-search',
          data: { mode: 'search', ranking: 'hybrid', files: [{ name: 'a.txt', passages: 1 }] },
        },
      ]),
    );
    expect(note?.textContent).toBe(
      'Searched project files by meaning and keywords. Used passages from a.txt (1 passage).',
    );
    expect(note?.getAttribute('data-project-ranking')).toBe('hybrid');
  });

  it('says when the results were reranked, and not when reranking fell back', async () => {
    const hybrid = await render(
      reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            ranking: 'hybrid',
            reranked: true,
            files: [{ name: 'a.txt', passages: 1 }],
          },
        },
      ]),
    );
    expect(hybrid?.textContent).toBe(
      'Searched project files by meaning and keywords and reranked the results. Used passages from a.txt (1 passage).',
    );
    expect(hybrid?.getAttribute('data-project-reranked')).toBe('true');

    const keyword = await render(
      reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            ranking: 'keyword',
            reranked: true,
            files: [{ name: 'a.txt', passages: 2 }],
          },
        },
      ]),
    );
    expect(keyword?.textContent).toBe(
      'Searched project files and reranked the results. Used passages from a.txt (2 passages).',
    );

    const fellBack = await render(
      reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            ranking: 'keyword',
            reranked: false,
            files: [{ name: 'a.txt', passages: 1 }],
          },
        },
      ]),
    );
    expect(fellBack?.textContent).toBe(
      'Searched project files. Used passages from a.txt (1 passage).',
    );
    expect(fellBack?.getAttribute('data-project-reranked')).toBe('false');
  });

  it('reads replies stored before reranking existed', async () => {
    const note = await render(
      reply([
        {
          type: 'data-project-search',
          data: { mode: 'search', files: [{ name: 'old.txt', passages: 1 }] },
        },
      ]),
    );
    expect(note?.textContent).toBe(
      'Searched project files. Used passages from old.txt (1 passage).',
    );
    expect(note?.hasAttribute('data-project-reranked')).toBe(false);
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

  it('expands to list the passages used, with their section when known', async () => {
    const note = await render(
      reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            files: [
              {
                name: 'handbook.md',
                passages: 3,
                excerpts: [
                  {
                    id: 'f1:2-3',
                    first: 2,
                    last: 3,
                    heading: 'Field trips',
                    snippet: 'Osprey trips leave at dawn…',
                  },
                  { id: 'f1:9-9', first: 9, last: 9, snippet: 'Bring a coat.' },
                ],
              },
            ],
          },
        },
      ]),
    );
    expect(note?.textContent).toBe(
      'Searched project files. Used passages from handbook.md (3 passages).',
    );
    const toggle = container.querySelector('button');
    expect(toggle?.textContent).toBe('Show passages used');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="project-search-passages"]')).toBeNull();

    await act(() => toggle!.click());
    const list = container.querySelector('[data-testid="project-search-passages"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-controls')).toBe(list?.id);
    expect(toggle?.textContent).toBe('Hide passages used');
    expect(list?.textContent).toBe(
      'handbook.mdPassages 2–3 · Field tripsOsprey trips leave at dawn…Passage 9Bring a coat.',
    );

    await act(() => toggle!.click());
    expect(container.querySelector('[data-testid="project-search-passages"]')).toBeNull();
  });

  it('has nothing to expand on replies stored before passages were kept', async () => {
    await render(
      reply([
        {
          type: 'data-project-search',
          data: { mode: 'search', files: [{ name: 'old.txt', passages: 1 }] },
        },
      ]),
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('names the files left out of the message', async () => {
    const withPassages = await render(
      reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            files: [{ name: 'a.txt', passages: 1 }],
            excluded: [{ name: 'b.txt' }, { name: 'c.txt' }],
          },
        },
      ]),
    );
    expect(withPassages?.textContent).toBe(
      'Searched project files. Used passages from a.txt (1 passage). Left out of this message: b.txt, c.txt.',
    );

    const only = await render(
      reply([
        {
          type: 'data-project-search',
          data: { mode: 'search', files: [], excluded: [{ name: 'b.txt' }] },
        },
      ]),
    );
    expect(only?.textContent).toBe('Left out of this message: b.txt.');
  });

  it('renders nothing without a valid part', async () => {
    expect(await render(reply([{ type: 'text', text: 'Plain reply' }]))).toBeNull();
    for (const data of [
      null,
      { mode: 'search', files: [] },
      { mode: 'other', files: [{ name: 'a.txt', passages: 1 }] },
      { mode: 'search', files: [{ name: 'a.txt', passages: 0 }] },
      { mode: 'search', files: [{ name: 42, passages: 1 }] },
      { mode: 'search', reranked: 'yes', files: [{ name: 'a.txt', passages: 1 }] },
      { mode: 'search', files: [], excluded: [] },
      {
        mode: 'search',
        files: [{ name: 'a.txt', passages: 1, excerpts: [{ id: 'x', snippet: 'No numbers' }] }],
      },
    ]) {
      const message = reply([{ type: 'data-project-search', data }]);
      expect(projectSearchOf(message)).toBeNull();
      expect(await render(message)).toBeNull();
    }
  });
});
