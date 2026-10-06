// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import {
  type ArtifactSummary,
  CODE_MARKDOWN_REFUSAL,
  MIN_MARKDOWN_ARTIFACT_CHARS,
  SHORT_HTML_REFUSAL,
  SHORT_MARKDOWN_REFUSAL,
} from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from './admin-test-utils';
import {
  createPart,
  liveHarness,
  prompt,
  reply,
  resetLiveArtifactTest,
  stream,
} from './artifacts-live.fixtures';

/**
 * A Markdown artifact the server declines because its content belongs in the
 * reply (#149) is not shown to the person as a failure (#201): no failed
 * steps, no note to the model, no "not saved" panel, live or after a reload.
 * The real list, rows, work block and artifacts provider.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
  HighlightedCode: ({ source }: { source: string }) => <pre>{source}</pre>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let root: Root | undefined;
let container: HTMLElement;
let listed: ArtifactSummary[] = [];
const { mount, docked, announcer } = liveHarness({
  container: () => container,
  mounted: (next, element) => {
    root = next;
    container = element;
  },
});

beforeEach(() => {
  listed = [];
  resetLiveArtifactTest(api, () => listed);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const TABLE = '| Colour | Example |\n| --- | --- |\n| Red | Apple |\n| Blue | Sky |';
const CODE = '```python\ndef reverse(text):\n    return text[::-1]\n```';
const ANSWER = { type: 'text' as const, text: `Here they are:\n\n${TABLE}\n\n${CODE}` };

const call = (id: string, title: string, content: string) => ({
  title,
  kind: 'markdown',
  content,
  id,
});
const part = (state: string, input: ReturnType<typeof call>, extra = {}) => ({
  ...(createPart(
    state,
    { title: input.title, kind: input.kind, content: input.content },
    extra,
  ) as object),
  toolCallId: input.id,
});
const declined = (input: ReturnType<typeof call>, note: string) =>
  part('output-available', input, { output: { saved: false, note } });

const table = call('c1', 'Three Primary Colours Table', TABLE);
const code = call('c2', 'Reverse a String', CODE);
const link = call('c3', 'Python Homepage Link', '[Python](https://www.python.org)');

/** What the person could see or hear of the attempts. */
function visibleTrace() {
  const text = container.textContent ?? '';
  return {
    failed: /failed/i.test(text),
    note: text.includes('Not saved as an artifact') || text.includes('belongs in'),
    titles: ['Three Primary Colours Table', 'Reverse a String', 'Python Homepage Link'].filter(
      (title) => text.includes(title),
    ),
    workBlock: container.querySelector('[data-reply-group="work"]') !== null,
    panel: docked() !== null,
  };
}
const NOTHING = { failed: false, note: false, titles: [], workBlock: false, panel: false };

describe('an artifact attempt declined as reply content (#201)', () => {
  it('never opens the panel or shows a step while the reply is written', async () => {
    await mount();
    await stream([prompt]);
    // Only the title so far: the panel waits for the kind.
    await stream([
      prompt,
      reply(
        createPart(
          'input-streaming',
          { title: 'Three Primary Colours Table' },
          {
            toolCallId: 'c1',
          },
        ),
      ),
    ]);
    expect(docked()).toBeNull();
    // The model writes a short table as a document: as written so far, it would be declined.
    await stream([
      prompt,
      reply(part('input-streaming', { ...table, content: '| Colour |' }) as never),
    ]);
    expect(visibleTrace()).toEqual(NOTHING);
    await stream([prompt, reply(part('input-available', table) as never)]);
    expect(visibleTrace()).toEqual(NOTHING);
    // Declined, then two more attempts, and the answer.
    await stream([
      prompt,
      reply(
        declined(table, SHORT_MARKDOWN_REFUSAL) as never,
        declined(code, CODE_MARKDOWN_REFUSAL) as never,
        part('input-streaming', link) as never,
      ),
    ]);
    expect(visibleTrace()).toEqual(NOTHING);
    const finished = reply(
      declined(table, SHORT_MARKDOWN_REFUSAL) as never,
      declined(code, CODE_MARKDOWN_REFUSAL) as never,
      declined(link, SHORT_MARKDOWN_REFUSAL) as never,
      ANSWER,
    );
    await stream([prompt, finished]);
    await stream([prompt, finished], false);
    expect(visibleTrace()).toEqual(NOTHING);
    expect(announcer()?.textContent ?? '').toBe('');
    expect(container.textContent).toContain('Here they are:');
  });

  it('still opens the panel on a Markdown document long enough to keep', async () => {
    await mount();
    await stream([prompt]);
    const report = call('c4', 'Quarterly Report', 'A sentence of the report. '.repeat(30));
    expect(report.content.length).toBeGreaterThan(MIN_MARKDOWN_ARTIFACT_CHARS);
    await stream([
      prompt,
      reply(part('input-streaming', { ...report, content: 'A sentence' }) as never),
    ]);
    expect(docked()).toBeNull();
    await stream([prompt, reply(part('input-streaming', report) as never)]);
    expect(docked()).not.toBeNull();
    expect(container.textContent).toContain('Quarterly Report');
  });

  it('shows nothing of them after a reload, including replies stored before the fix', async () => {
    await mount([
      prompt,
      reply(
        declined(table, SHORT_MARKDOWN_REFUSAL) as never,
        // Stored before #201: the decline was the step's error.
        part('output-error', code, { errorText: CODE_MARKDOWN_REFUSAL }) as never,
        ANSWER,
      ),
    ]);
    expect(visibleTrace()).toEqual(NOTHING);
    expect(container.textContent).toContain('Here they are:');
  });

  it('leaves out a short HTML page declined the same way (#313)', async () => {
    const page = {
      ...call('c6', 'Three Primary Colours Table', '<!doctype html><table></table>'),
      kind: 'html',
    };
    const finished = reply(declined(page, SHORT_HTML_REFUSAL) as never, ANSWER);
    await mount();
    await stream([prompt]);
    await stream([prompt, finished]);
    await stream([prompt, finished], false);
    expect(visibleTrace()).toEqual(NOTHING);
    await cleanup(root!);
    await mount([prompt, finished]);
    expect(visibleTrace()).toEqual(NOTHING);
    expect(container.textContent).toContain('Here they are:');
  });

  it('still shows an artifact call that really failed', async () => {
    await mount([
      prompt,
      reply(
        part('output-error', table, { errorText: 'An artifact can be at most 512 KB.' }) as never,
        ANSWER,
      ),
    ]);
    expect(container.querySelector('[data-reply-group="work"]')?.textContent).toMatch(/failed/i);
  });
});
