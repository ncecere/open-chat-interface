// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg data-test="diagram"></svg>' })),
}));
const imported = vi.hoisted(() => ({ count: 0 }));
vi.mock('mermaid', () => {
  imported.count += 1;
  return { default: mermaid };
});

import {
  createEditorialMermaidPlugin,
  editorialMermaidConfig,
} from '../../src/components/chat/mermaid-plugin';

beforeEach(() => {
  mermaid.initialize.mockClear();
  mermaid.render.mockClear();
  document.documentElement.className = '';
});

it('renders model diagrams with strict security and no HTML labels', () => {
  const config = editorialMermaidConfig();
  expect(config.securityLevel).toBe('strict');
  expect(config.startOnLoad).toBe(false);
  expect(config.theme).toBe('base');
});

it('uses flat hairline styling and reserves the accent for focus nodes', () => {
  const css = editorialMermaidConfig().themeCSS ?? '';
  expect(css).toContain('stroke-width: 1px');
  expect(css).toContain('filter: none');
  expect(css).toMatch(/\.node\.focus rect[\s\S]*stroke:/);
});

it('follows the page theme', () => {
  expect(editorialMermaidConfig().themeVariables?.darkMode).toBe(false);
  document.documentElement.classList.add('dark');
  expect(editorialMermaidConfig().themeVariables?.darkMode).toBe(true);
});

it('loads Mermaid only when a diagram renders, applying the editorial config each time', async () => {
  const plugin = createEditorialMermaidPlugin();
  expect(plugin).toMatchObject({ name: 'mermaid', type: 'diagram', language: 'mermaid' });
  const instance = plugin.getMermaid();
  // Streamdown's own options never override the editorial config.
  instance.initialize({ theme: 'forest', securityLevel: 'loose' });
  expect(mermaid.initialize).not.toHaveBeenCalled();

  await expect(instance.render('diagram-1', 'graph TD; A-->B')).resolves.toEqual({
    svg: '<svg data-test="diagram"></svg>',
  });
  expect(imported.count).toBe(1);
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: 'strict', theme: 'base' }),
  );
  expect(mermaid.render).toHaveBeenCalledWith('diagram-1', 'graph TD; A-->B');
});
