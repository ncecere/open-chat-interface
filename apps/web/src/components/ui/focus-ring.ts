/**
 * The keyboard focus ring for buttons, shared by the Button variants and the
 * composer's own Send and Stop buttons (#355).
 *
 * Two things made the ring on filled buttons look absent:
 *
 * 1. `transition-colors` also transitions `outline-color`. The ring's colour
 *    came only from global.css's `:focus-visible`, so unfocused the outline
 *    colour was `currentcolor` (the button's own text: near white on New Chat
 *    and Sign in in light, near black in dark), and on focus it faded to
 *    --accent-bright over 150 ms. The ring started as the button's text colour
 *    on the page colour (1.04:1) and a keyboard user tabbing through, or a
 *    screenshot taken straight after Tab, saw no ring. Giving the outline its
 *    colour all the time leaves nothing to fade.
 * 2. A ring outside the button is only measured against what is around the
 *    button. Filled buttons also get a thin inner ring in the button's text
 *    colour, which every variant already keeps at 4.5:1 or more against its
 *    own fill, so the focus shows on any surface and on any accent fill.
 *
 * The outer ring uses --accent-bright like every other ring (3:1 or more on
 * each surface in every theme and accent; see tests/unit/button-focus-ring).
 */
export const FOCUS_RING = [
  'outline-[var(--accent-bright)]',
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2',
].join(' ');

/** The inner ring for a button with a fill: its text colour, inside the edge. */
export const FILLED_FOCUS_RING = 'focus-visible:shadow-[inset_0_0_0_2px_currentColor]';
