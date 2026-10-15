// @vitest-environment happy-dom
import type { CatalogModel, ClassificationResponse, DataClassBlockedDetails } from '@oci/shared';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlockedSendNotice,
  ComposerClassificationNote,
} from '../../src/components/chat/classification-note';
import {
  DataClassificationNote,
  dataClassificationOf,
} from '../../src/components/chat/data-classification-note';
import { ProjectSearchNote, projectSearchOf } from '../../src/components/chat/project-search-note';

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
const render = (ui: React.ReactNode) => act(() => root.render(ui));

const model = (slug: string, displayName: string) =>
  ({ id: slug, slug, displayName }) as unknown as CatalogModel;
const plain = model('plain', 'Plain model');
const approved = model('approved', 'Approved model');

function classification(
  mode: 'warn' | 'block',
  models: ClassificationResponse['models'],
): ClassificationResponse {
  return {
    mode,
    classes: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
    models,
  };
}
const missing = [{ id: 'c1', name: 'Student records' }];

describe('the note above the message box', () => {
  it('in block, says the chosen model cannot take the conversation and to choose another', async () => {
    await render(
      <ComposerClassificationNote
        selectedModel={plain}
        classification={classification('block', [
          { slug: 'plain', displayName: 'Plain model', status: 'blocked', missing },
          { slug: 'approved', displayName: 'Approved model', status: 'ok', missing: [] },
        ])}
      />,
    );
    const note = container.querySelector('[data-classification-composer-note="blocked"]');
    expect(note?.getAttribute('role')).toBe('status');
    expect(note?.textContent).toBe(
      'Plain model is not approved for Student records, which this conversation carries. Choose a model that is approved for it before you send.',
    );
  });

  it('says to ask an administrator when no model is approved', async () => {
    await render(
      <ComposerClassificationNote
        selectedModel={plain}
        classification={classification('block', [
          { slug: 'plain', displayName: 'Plain model', status: 'blocked', missing },
        ])}
      />,
    );
    expect(container.textContent).toContain(
      'No model is approved for it yet. Ask an administrator.',
    );
  });

  it('in warn, says the message will still be sent and the administrator will see it', async () => {
    await render(
      <ComposerClassificationNote
        selectedModel={plain}
        classification={classification('warn', [
          { slug: 'plain', displayName: 'Plain model', status: 'warn', missing },
        ])}
      />,
    );
    const note = container.querySelector('[data-classification-composer-note="warn"]');
    expect(note?.textContent).toBe(
      'Plain model is not approved for Student records, which this conversation carries. Your message will still be sent, and the administrator will see this in the audit log.',
    );
  });

  it('is silent for an approved model, with classification off, and with no model or answer', async () => {
    const answer = classification('block', [
      { slug: 'approved', displayName: 'Approved model', status: 'ok', missing: [] },
    ]);
    await render(<ComposerClassificationNote selectedModel={approved} classification={answer} />);
    expect(container.innerHTML).toBe('');
    await render(
      <ComposerClassificationNote
        selectedModel={plain}
        classification={{ mode: 'off', classes: [], models: [] }}
      />,
    );
    expect(container.innerHTML).toBe('');
    await render(<ComposerClassificationNote selectedModel={null} classification={answer} />);
    expect(container.innerHTML).toBe('');
    await render(<ComposerClassificationNote selectedModel={plain} classification={undefined} />);
    expect(container.innerHTML).toBe('');
    // A model the answer does not list (a new one) is not judged here.
    await render(<ComposerClassificationNote selectedModel={plain} classification={answer} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('a refused send', () => {
  const details: DataClassBlockedDetails = {
    point: 'send',
    model: { slug: 'plain', displayName: 'Plain model' },
    missing: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
    approvedModels: [
      { slug: 'approved', displayName: 'Approved model' },
      { slug: 'gone', displayName: 'No longer listed' },
    ],
  };
  const message =
    'Your message was not sent. Plain model is not approved for Student records, which this conversation carries. Choose a model that is approved for it.';

  it('shows the server’s sentence and the approved models as buttons', async () => {
    const onChoose = vi.fn();
    await render(
      <BlockedSendNotice
        message={message}
        details={details}
        models={[plain, approved]}
        onChoose={onChoose}
      />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    // A model the person can no longer pick is not offered.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((node) => node.textContent)).toEqual(['Use Approved model']);
    await act(() => buttons[0]!.click());
    expect(onChoose).toHaveBeenCalledWith(approved);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Switched to Approved model. Your message is back in the box: send it again.',
    );
  });

  it('offers no model for a refusal another model cannot put right', async () => {
    for (const point of ['approval', 'compaction', 'share'] as const) {
      await render(
        <BlockedSendNotice
          message="Refused."
          details={{ ...details, point }}
          models={[plain, approved]}
          onChoose={vi.fn()}
        />,
      );
      expect(container.querySelector('button')).toBeNull();
      expect(container.textContent).toContain('Refused.');
    }
  });

  it('says nothing more when no model is approved', async () => {
    await render(
      <BlockedSendNotice
        message={message}
        details={{ ...details, approvedModels: [] }}
        models={[plain]}
        onChoose={vi.fn()}
      />,
    );
    expect(container.querySelector('button')).toBeNull();
  });
});

function reply(parts: unknown[]): UIMessage {
  return { id: 'assistant-1', role: 'assistant', parts: parts as UIMessage['parts'] };
}

describe('the notes on a reply', () => {
  it('shows what warn let through, from the data-classification part', async () => {
    const message = reply([
      { type: 'text', text: 'Hello.' },
      {
        type: 'data-classification',
        data: { mode: 'warn', point: 'send', model: 'plain', missing: ['Student records'] },
      },
    ]);
    expect(dataClassificationOf(message)?.missing).toEqual(['Student records']);
    await render(<DataClassificationNote message={message} />);
    const note = container.querySelector('[role="note"]');
    expect(note?.getAttribute('data-data-classification')).toBe('send');
    expect(note?.textContent).toBe(
      'This conversation carries Student records, which this model is not approved for. It was sent anyway because data classification is set to warn; the administrator can see this in the audit log.',
    );
  });

  it('shows nothing for a reply without the part, or with one it cannot read', async () => {
    for (const message of [
      reply([{ type: 'text', text: 'Hello.' }]),
      reply([{ type: 'data-classification', data: { mode: 'block', missing: [] } }]),
      reply([{ type: 'data-classification', data: { mode: 'warn', point: 'send', missing: [] } }]),
    ]) {
      expect(dataClassificationOf(message)).toBeNull();
      await render(<DataClassificationNote message={message} />);
      expect(container.innerHTML).toBe('');
    }
  });

  it('says which outside services project search left out, like the search note it sits with', async () => {
    const note = async (withheld: Array<'embeddings' | 'reranking'>, files = true) => {
      const message = reply([
        {
          type: 'data-project-search',
          data: {
            mode: 'search',
            files: files ? [{ name: 'a.txt', passages: 1 }] : [],
            withheld,
          },
        },
      ]);
      await render(<ProjectSearchNote message={message} />);
      return container.querySelector('[role="note"]');
    };
    const embeddings = await note(['embeddings']);
    expect(embeddings?.textContent).toContain(
      'Meaning-based search is not approved for a data class this conversation carries, so project files were searched by keywords only.',
    );
    expect(embeddings?.getAttribute('data-project-withheld')).toBe('embeddings');
    expect((await note(['reranking']))?.textContent).toContain(
      'Reranking is not approved for a data class this conversation carries, so the passages kept their combined order.',
    );
    expect((await note(['embeddings', 'reranking']))?.textContent).toContain(
      'Meaning-based search and reranking are not approved',
    );
    // Even with no file named, the note says what was withheld.
    expect(
      projectSearchOf(
        reply([
          {
            type: 'data-project-search',
            data: { mode: 'search', files: [], withheld: ['reranking'] },
          },
        ]),
      ),
    ).not.toBeNull();
    expect((await note(['reranking'], false))?.textContent).toContain('Reranking is not approved');
  });
});
