/**
 * Where keyboard focus goes after an in-app navigation that removes or hides
 * the control that had it (WCAG 2.4.3, #242, #251).
 *
 * The destination is often not ready in the frame the navigation finishes: a
 * closing phone drawer leaves the page inert for a render, an open dialog
 * hides it from assistive technology until it unmounts, and a route renders
 * after its code arrives. So focus is moved once the target exists and can
 * take it, checked each frame for a short while.
 */

/** The new chat's message box. */
const COMPOSER = 'textarea[aria-label="Message input"]';

/**
 * How long to keep trying, in milliseconds rather than frames, whose rate
 * differs from screen to screen. Two seconds: a fresh load keeps the page
 * invisible until the announcements have been read (#167), and nothing can
 * take focus then.
 */
const PATIENCE_MS = 2000;

/** Whether `element` is hidden from interaction by a drawer or a dialog. */
function blocked(element: HTMLElement): boolean {
  return element.closest('[inert], [aria-hidden="true"]') !== null;
}

/**
 * Focuses what `find` returns as soon as it can take focus, trying each
 * frame. `until` is asked first every time; when it says the moment has
 * passed (the person moved focus somewhere themselves), nothing is done.
 */
export function focusWhenReady(
  find: () => HTMLElement | null,
  { until = () => false, within = PATIENCE_MS }: { until?: () => boolean; within?: number } = {},
) {
  if (typeof window === 'undefined') return;
  const deadline = performance.now() + within;
  const attempt = () => {
    if (until()) return;
    const target = find();
    if (target && !blocked(target) && !(target as HTMLTextAreaElement).disabled) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    if (performance.now() < deadline) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/**
 * True on a device whose only pointer is a finger. Focusing a field there
 * opens the on-screen keyboard over the page, so a new chat on a phone shows
 * its suggestions rather than jumping into the message box (#251).
 */
export function touchOnly(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

/**
 * After New Chat (the button, ⌘⇧O, the palette), puts the cursor in the
 * message box: a new chat exists to be typed in (#251). Also when the person
 * was already on the home page, where nothing remounts to take focus.
 */
export function focusComposerSoon() {
  if (touchOnly()) return;
  focusWhenReady(() => document.querySelector<HTMLElement>(COMPOSER));
}

/**
 * When the home page appears, however the person arrived (a fresh load, a
 * link): the cursor goes to the message box once the page can take it,
 * unless the person has put focus somewhere meanwhile (#251).
 */
export function focusComposerOnArrival() {
  if (touchOnly()) return;
  focusWhenReady(() => document.querySelector<HTMLElement>(COMPOSER), {
    until: () => {
      const active = document.activeElement;
      return Boolean(active && active !== document.body && !active.matches(COMPOSER));
    },
  });
}
