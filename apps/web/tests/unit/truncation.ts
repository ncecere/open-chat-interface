/**
 * Text that `truncate` may cut short with an ellipsis but that has no tooltip
 * with its full value (#110, #130).
 *
 * happy-dom has no layout, so it cannot tell which text actually overflows;
 * every truncatable element is checked, as any of them can overflow on a
 * phone. Covered means a `title` on the element or an ancestor containing
 * the whole text.
 */
export function untitledTruncations(root: ParentNode = document): string[] {
  const missing: string[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('.truncate')) {
    const text = element.textContent?.replace(/\s+/g, ' ').trim();
    if (!text || element.closest('[aria-hidden="true"]')) continue;
    let covered = false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const title = node.getAttribute('title')?.replace(/\s+/g, ' ');
      if (title?.includes(text)) {
        covered = true;
        break;
      }
    }
    if (!covered) missing.push(text);
  }
  return missing;
}

/**
 * Text the compiled CSS keeps to one line and clips (`truncate`, or
 * `whitespace-nowrap` with `overflow-hidden`) without a tooltip of its full
 * value (#195). Unlike `untitledTruncations`, it reads the generated styles,
 * so a class that cuts text under another name is caught too.
 */
export async function clippedWithoutTooltip(root: ParentNode = document): Promise<string[]> {
  const { styleFor } = await import('./css-test-utils');
  const missing: string[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('[class]')) {
    const text = element.textContent?.replace(/\s+/g, ' ').trim();
    if (!text || element.closest('[aria-hidden="true"], .sr-only')) continue;
    const style = await styleFor(element.getAttribute('class') ?? '');
    const oneLine = style['white-space'] === 'nowrap' || style['text-wrap'] === 'nowrap';
    const clipped = style.overflow === 'hidden' || style['text-overflow'] === 'ellipsis';
    if (!oneLine || !clipped) continue;
    let covered = false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.getAttribute('title')?.replace(/\s+/g, ' ').includes(text)) {
        covered = true;
        break;
      }
    }
    if (!covered) missing.push(text);
  }
  return missing;
}

/**
 * Text the compiled CSS keeps to one line and clips, tooltip or not (#244).
 * A `title` is read only on hover, which a touch screen has not got, so text
 * a person must read in full (a file's name) should not be in this list.
 */
export async function clippedOnTouch(root: ParentNode = document): Promise<string[]> {
  const { styleFor } = await import('./css-test-utils');
  const clipped: string[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('[class]')) {
    const text = element.textContent?.replace(/\s+/g, ' ').trim();
    if (!text || element.closest('[aria-hidden="true"], .sr-only')) continue;
    const style = await styleFor(element.getAttribute('class') ?? '');
    const oneLine = style['white-space'] === 'nowrap' || style['text-wrap'] === 'nowrap';
    const cut = style.overflow === 'hidden' || style['text-overflow'] === 'ellipsis';
    if (oneLine && cut) clipped.push(text);
  }
  return clipped;
}
