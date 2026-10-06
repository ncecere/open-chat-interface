// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';

/**
 * How a reply that did not finish normally reads, live and after a reload.
 * Messages are shaped as the server's history gives them (routes/chat.ts
 * toUIMessage: status and errorMessage in the metadata).
 */
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

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

async function render(props: ComponentProps<typeof MessageList>) {
  await act(() => root.render(<MessageList {...props} />));
}

const question: UIMessage = {
  id: 'q',
  role: 'user',
  parts: [{ type: 'text', text: 'Walk3 dead provider: hi' }],
};
function saved(
  status: string,
  errorMessage: string | null,
  parts: UIMessage['parts'] = [],
): UIMessage {
  return {
    id: 'a',
    role: 'assistant',
    parts,
    metadata: { modelSlug: 'alpha', effort: null, status, errorMessage },
  };
}
const reply = () => container.querySelector('article[aria-label="Assistant message"]')!;

describe('a failed reply (#133)', () => {
  it('says it failed, and why, where the reply would be, with Try again', async () => {
    const onRetry = vi.fn();
    await render({
      messages: [question, saved('error', 'The model failed to generate a response')],
      streaming: false,
      onRetry,
    });
    const alert = reply().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'This reply failed. The model failed to generate a response.',
    );
    const retry = [...reply().querySelectorAll('button')].find(
      (node) => node.textContent === 'Try again',
    );
    await act(() => retry!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the text a failed reply had, and says so under an older one without alerting', async () => {
    await render({
      messages: [
        question,
        saved('error', null, [{ type: 'text', text: 'Partial answer' }]),
        { ...question, id: 'q2' },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Fine' }] },
      ],
      streaming: false,
      onRetry: vi.fn(),
    });
    const first = container.querySelector('[data-message-id="a"]')!;
    expect(first.textContent).toContain('Partial answer');
    expect(first.querySelector('[role="note"]')?.textContent).toContain(
      'This reply failed. The reply could not be generated.',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('says nothing about a reply that finished', async () => {
    await render({
      messages: [question, saved('complete', null, [{ type: 'text', text: 'Hello' }])],
      streaming: false,
      onRetry: vi.fn(),
    });
    expect(reply().textContent).not.toContain('failed');
  });
});
