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
