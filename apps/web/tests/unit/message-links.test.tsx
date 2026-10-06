// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';

/**
 * Links in messages (#174), through the real lazily loaded Streamdown
 * renderer: ordinary links in the sentence, not inline-block buttons, that
 * still warn before leaving the instance.
 */
const LONG_URL =
  'https://docs.example.edu/research-computing/storage/quotas-and-allocations/how-to-request-more-space';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(markdown: string) {
  await act(async () => root.render(<Markdown>{markdown}</Markdown>));
  await vi.waitFor(
    () => expect(container.querySelector('[data-streamdown="link"]')).not.toBeNull(),
    {
      timeout: 5_000,
    },
  );
}

/** Clicks, and reports whether the page stopped the browser following the link. */
function click(element: Element): boolean {
  let prevented = false;
  // Last to see the click: read what the link did, then keep happy-dom from navigating.
  const record = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', record);
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  document.removeEventListener('click', record);
  return prevented;
}

describe('links in messages (#174)', () => {
  it('are links in the sentence, with their address, opening in a new tab', async () => {
    await render(`See ${LONG_URL}, a 40-line TypeScript example, for details.`);
    const link = container.querySelector('[data-streamdown="link"]')!;
    expect(link.tagName).toBe('A');
    expect(container.querySelector('button')).toBeNull();
    expect(link.getAttribute('href')).toBe(LONG_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // In the same paragraph as the text around it.
    expect(link.parentElement?.textContent).toContain(', a 40-line TypeScript example');
  });

  it('warns before opening a link that leaves the instance', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render('Read [the quota guide](https://docs.example.edu/quota).');
    expect(click(container.querySelector('a[href]')!)).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'Open External Link',
      ),
    );
    expect(open).not.toHaveBeenCalled();
    const proceed = [...document.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.textContent === 'Continue',
    )!;
    act(() => (proceed as HTMLButtonElement).click());
    expect(open).toHaveBeenCalledWith(
      'https://docs.example.edu/quota',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('follows a link within the instance without a warning', async () => {
    await render(`Open [your settings](${window.location.origin}/settings/history).`);
    expect(click(container.querySelector('a[href]')!)).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
