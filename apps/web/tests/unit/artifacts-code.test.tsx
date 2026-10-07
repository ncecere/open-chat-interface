// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { PublicArtifact } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { artifactFilename } from '../../src/components/artifacts/artifact-panel';
import { PublicArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { button, cleanup, click, dialog } from './admin-test-utils';
import { frames, mountWithQueryClient, resetArtifactTest } from './artifacts.fixtures';

/**
 * A code artifact (#298). Asked for "a Code artifact" holding a Python
 * script, the model could only make an HTML page around it: the card said
 * "HTML", the preview read `<inventory.csv>` as a tag and dropped it, and
 * Download gave an `.html` file. A code artifact is labelled by its language,
 * previewed as code with every character as written, and downloads with its
 * language's extension. The real panel, preview and Markdown/highlighting
 * renderer; only the API client is a stand-in (and never called here).
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), download: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

const USAGE = 'print("Usage: python inventory.py <inventory.csv> [threshold]")';
const SCRIPT = ['import csv', 'import sys', '', 'if len(sys.argv) < 2:', `    ${USAGE}`].join('\n');
const shared: PublicArtifact[] = [
  {
    messageId: 'reply-1',
    sourceKey: 'tool:c1',
    title: 'Walk6 inventory script',
    kind: 'code',
    language: 'python',
    version: 1,
    content: SCRIPT,
  },
];

let root: Root | undefined;
beforeEach(() => resetArtifactTest(api));
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(artifacts: PublicArtifact[]) {
  await mountWithQueryClient(
    <PublicArtifactsProvider artifacts={artifacts} markdownProps={{ skipHtml: true }}>
      <CreatedArtifactCards messageId="reply-1" />
    </PublicArtifactsProvider>,
    (next) => {
      root = next;
    },
  );
}

async function open() {
  await mount(shared);
  const card = button('Open artifact: Walk6 inventory script');
  expect(card.textContent).toContain('Python · version 1');
  await click(card);
}

it('names a code artifact by its language and previews it as code, angle brackets and all', async () => {
  await open();
  const panel = dialog()!;
  expect(panel.textContent).toContain('Python · version 1');
  // The preview tab shows the script itself: no page, no Markdown reading of it.
  expect(button('Preview').getAttribute('aria-selected')).toBe('true');
  expect(frames()).toHaveLength(0);
  const preview = panel.querySelector('[role="tabpanel"]')!;
  expect(preview.textContent).toContain(USAGE);
  // Read as code, not as markup: no element came of `<inventory.csv>`.
  expect(
    [...preview.querySelectorAll('*')].some((node) => node.localName === 'inventory.csv'),
  ).toBe(false);
});

it('draws a kind it does not know, as a later release may make one during an upgrade', async () => {
  // The previous release looked the card's icon up by kind and had none for
  // `code`, so its card had nothing to draw and broke the conversation; this
  // release must not do the same to the next kind.
  const later = { ...shared[0]!, kind: 'notebook' as PublicArtifact['kind'], language: null };
  await mount([later]);
  const card = button('Open artifact: Walk6 inventory script');
  expect(card.textContent).toContain('Artifact · version 1');
  await click(card);
  const preview = dialog()!.querySelector('[role="tabpanel"]')!;
  expect(preview.textContent).toContain(USAGE);
  expect(artifactFilename('Later', later.kind)).toBe('later.txt');
});

it('downloads a code artifact with its language’s extension', async () => {
  expect(artifactFilename('Walk6 inventory script', 'code', 'python')).toBe(
    'walk6-inventory-script.py',
  );
  expect(artifactFilename('Deploy', 'code', 'sh')).toBe('deploy.sh');
  expect(artifactFilename('Snippet', 'code', 'brainfudge')).toBe('snippet.txt');
  const blobs: Blob[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:code';
    }),
    revokeObjectURL: vi.fn(),
  });
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  await open();
  await click(button('Download'));
  expect(names).toEqual(['walk6-inventory-script.py']);
  expect(blobs[0]?.type).toBe('text/plain;charset=utf-8');
  expect(await blobs[0]?.text()).toBe(SCRIPT);
});
