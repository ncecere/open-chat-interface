# Accessibility findings

Defects the audit found, from the first run of `pnpm a11y:audit` (the `smoke` matrix, see the
[report](acr.md) for exactly what ran) and from the inspections in [inspections.md](inspections.md).
Each has its criterion, route, severity, evidence and a suggested fix.

**Status.** The application was being changed while this audit was made (CSS converted to logical
properties, strings extracted for translation), so nothing was fixed in that run. The fixes came
after, on the branch `v0.14/a11y-fixes-1` (D1 to D5, outside the chat area), each with a test that
failed first; each finding below says which commit fixed it and what is still open. The chat area
(components/chat, components/artifacts, routes/chat) was being translated at the time and is fixed
later (D6, D7, the model picker and message box under D1, D2 and D4, the reduced-motion notes). The
final audit runs after the application settles; a finding that still reproduces then is fixed with a
test that fails first, or filed as an issue and the report's row stays "Partially Supports". The
evidence keys are the `rule` names in `evidence.json` (`findings[].rule`); a test fails if a finding
there is missing from this file.

The focused re-run after the fixes (`pnpm a11y:audit --matrix smoke --only pages`, the same 32
contexts as the first run, on a freshly seeded instance) went from 172 findings to 8; the 8 are all
in the chat area (the message box, the model picker under it) and are listed under D1, D2 and D4.

This is a record of the first run, on build 68f91a59 (version file 0.13.1, before the release
bump). Numbers can change after the interface changes; re-run before trusting any of them.

## What the first run found nothing in

Not a conformance claim, only what the checks saw: axe-core scanned 380 page loads and reported no violation of any
impact; no text pair failed 1.4.3 (380 page loads, every text pair as rendered); no page scrolled sideways
at 320 px or at 400% zoom (152 samples); no target failed 2.5.8 apart from D5 (380 page loads); every one of the
13 keyboard walkthroughs completed; no tab-order trap, missing focus indicator or entirely covered focus
was found on the pages walked; the second step of sign-in allows paste, names the field
`one-time-code`, asks for nothing again and sets no puzzle. Several of these checks only test
part of a criterion (the report says which), and nobody used a screen reader.

## D1. The edge of form fields is too faint (1.4.11, moderate)

**Status: fixed outside the chat area (3179e81c); the message box and the model picker under it are
open.** `--border-control` (`#696969` in dark, `#808080` in light: 3.1:1 to 3.6:1 and 3.3:1 to 4.0:1
on every surface a field sits on) is the edge of `Input`, `Textarea`, the select trigger, the
Customization fields and the attachments filter, and the off track of the switch; the sidebar search
has an edge. Checked in light and dark and all four accents on the sign-in page, Customization,
administration (general settings, audit log) and the home page: 111 findings over 33 routes before,
none outside the chat area after. Still open: the message box (`textarea` inside a `div.border.px-4`
in `components/chat/composer.tsx`, which has the edge on its wrapper, `--border-strong`, not on the
field) and the model picker under it (a ghost button): 4 findings on `/` and `/chat/$threadId`,
fixed with the chat area by giving the wrapper `border-[var(--border-control)]` and the picker the
same edge as a select.

- **Criterion:** 1.4.11 Non-text Contrast. **Evidence:** `field-boundary-contrast`, 111 findings
  over 33 routes.
- **Routes (examples):** `/auth/login`, `/auth/verify-email`, `/` (the sidebar search and the
  message box), `/settings/customization`, `/settings/models`, `/admin/roles`,
  `/admin/settings/general`, `/admin/users`. The list is in `evidence.json`.
- **What:** Text fields, text areas, select triggers and switch tracks have an edge of about
  1.2:1 to 1.3:1 against what is around them (some 1.0:1: no border and no fill), in both themes
  and all four accents. The border colour is the only thing that marks where a field is.
- **How measured:** the border colours and the fill of each field against the colour behind it
  (`checks/measured.mjs`, `nonTextContrastCheck`); the best of border and fill counts. This is the
  strict reading of 1.4.11, where the edge is what identifies a control. A field with a visible
  label and placeholder is identifiable without its edge on some readings; the audit reports it
  anyway. Whether the strict reading is the project's is a decision for the maintainer.
- **Suggested fix:** a separate border token for form controls at 3:1 or more against the surface in
  each theme (`--border-control` in `styles/tokens.css`, used by `Input`, `Textarea`, `Select`,
  the switch track and the composer), leaving the decorative dividers as they are.

## D2. Text is cut off under the 1.4.12 text spacing (1.4.12, moderate)

**Status: fixed outside the chat area (023220f2); the model picker's label is open.** Titles and
names in the sidebar, the lists and Settings now take two lines before an ellipsis, technical values
break where they must (nothing cut), the Select trigger's value takes two lines. 20 moderate and 18
review findings over 17 and 13 routes before; after, the one that remains is the model picker's label
under the message box (`components/chat/model-picker.tsx`, `span.min-w-0.truncate`, 33 px at 320 px,
review). The full text of a project and of a group is the heading of its page. A conversation's full
title is the tab's title and the page's heading for a screen reader, but **not a visible heading**: the
`h1` in `routes/chat/thread.tsx` is `sr-only`, so the sentence above ("the conversation page already
shows the full title in its heading") was only true for a screen reader. The sidebar row has the full
title as its `title` and the Rename dialog shows it; a visible title on the conversation page is for
the chat area.

- **Criterion:** 1.4.12 Text Spacing. **Evidence:** `text-spacing-clipping` (moderate: 20
  findings over 17 routes; review: 18 findings over 13 routes where the text was already
  truncated and loses more).
- **Routes:** `/` (sidebar conversation titles), `/projects`, `/projects/$projectId`,
  `/settings` and every Settings tab (the account name and email line), `/admin/audit`,
  `/admin/groups`, `/admin/users`, `/admin/users/$userId`, `/admin/backups`.
- **What:** Boxes with `truncate` (single line, `overflow: hidden`, ellipsis) hide more of their text
  once line, letter and word spacing are increased: 5 to 77 px of a conversation title, a name, a
  cell. The ellipsis shows that text is missing; it does not say what.
- **Suggested fix:** let titles and names wrap to two lines (`line-clamp-2` with room, not
  `truncate`) where there is space, and make the full text available (a `title` is not enough on
  touch: the conversation page already shows the full title in its heading; do the same for
  project and group names).

## D3. Text overlaps under the 1.4.12 text spacing (1.4.12, serious)

**Status: fixed (e8d2a7ff).** The cause was not a fixed height: the name and address under the avatar
were `truncate` boxes inside a `lg:flex-none` container, which takes the width of its text, so the box
was wider than its 15rem column and ran under the page beside it (the audit's account has a long
address). The container is the width of the column and the text breaks where it must. 5 findings
before, none after, with a person whose address is 70 characters.

- **Criterion:** 1.4.12 Text Spacing. **Evidence:** `text-spacing-overlap`, 5 findings.
- **Routes:** `/settings`, `/settings/customization`, `/settings/groups`, `/settings/history`,
  `/settings/memory`.
- **What:** With the spacing applied, the single-line paragraph (`p.truncate.text-sm`) in the
  Settings page header overlaps the next text box by 54 to 726 px2: the first lines of the page
  collide.
- **Suggested fix:** do not give the header a fixed height or position its lines absolutely; let the
  block grow. Re-run `--only pages --routes '^/settings'` to confirm.

## D4. Text resize to 200% breaks four layouts (1.4.4, serious and moderate)

**Status: fixed outside the chat area (20d814c6, 023220f2); the model picker's label is open.** The
four layouts broke because a breakpoint is a width of the window while the text is sized in rem:
side-by-side rows kept going side by side with a fraction of the room. Branding (form beside its
preview), the settings sections (18rem title beside the form), Customization's appearance control and
the language row are now container queries (they go side by side by the room they have, so at larger
text they stack; at 100% the pages look as before); a provider's action buttons may wrap
(`/admin/models`); the labels of the user page's four figures break inside their cell. The truncated
names are as for D2. Before: 2 overlaps, 12 clippings (1 serious), 1 sideways; after: the model
picker's label under the message box (`/` and `/chat/$threadId`, moderate, 131 px), in the chat area.

- **Criterion:** 1.4.4 Resize Text. **Evidence:** `text-resize-overlap` (2), `text-resize-clipping`
  (1 serious, 7 moderate, 4 review), `text-resize-sideways` (1).
- **Routes:** `/admin/branding` (two section headings overlap), `/admin/users/$userId` (two labels
  overlap), `/admin/models` (a table container hides 12 px of content), `/settings/customization`
  (content runs past the edge of the window), and truncated names on `/`, `/admin`, `/admin/audit`,
  `/admin/usage`, `/chat/$threadId`, `/settings`.
- **How measured:** the root font size is doubled, which scales what is sized in `rem`; it is not
  the browser's zoom control (the report says so).
- **Suggested fix:** the same as D2 and D3 for the truncated and overlapping text; for
  `/admin/models` replace the fixed-width container's `overflow-hidden` with a horizontally
  scrollable region; for `/settings/customization` find the `shrink-0` row that does not wrap.

## D5. The hover action buttons in the sidebar are too small and too close (2.5.8, moderate)

**Status: fixed (86b79068).** The three buttons are 24 by 24 px, and the link gives up 5rem at its end
while the row is hovered or has focus, so the buttons are beside the title and not over the link (the
`focus-partly-obscured` review item has the same cause and the same fix). 4 findings before, none after.

- **Criterion:** 2.5.8 Target Size (Minimum). **Evidence:** `target-size`, 4 findings (each with 8
  to 12 occurrences).
- **Routes:** every page with the sidebar: `/`, `/chat/$threadId`, `/projects`,
  `/projects/$projectId`.
- **What:** The Pin, Rename and Archive buttons that appear on a conversation row
  (`button.rounded.p-1` in a `pointer-events-none absolute` group) are 22 by 22 px and sit within
  12 px of each other, so neither the size nor the spacing exception applies. The focus check also
  recorded that these buttons partly cover the conversation link they sit over (`focus-partly-obscured`,
  a review item; level AA fails it only when entirely hidden).
- **Suggested fix:** `p-1.5` (24 px) or a larger gap between the three; move them clear of the link's
  text. Fixes the review item too.

## D6. A streaming reply is not announced (4.1.3, serious)

**Status: open, in the chat area (later).**

- **Criterion:** 4.1.3 Status Messages. **Evidence:** `reply-not-announced`, route
  `/chat/$threadId`; the observation is in `facts.statusMessages["streaming-reply"]` (zero
  live-region announcements from the start of a reply to its end).
- **What:** While a reply is written and when it finishes, no live region changes: the "waiting"
  indicator in `message-list.tsx` is a `role="status"` element with an `aria-label` and no text, which
  a screen reader does not reliably announce. A person who cannot see the page is not told that a reply
  is coming or has arrived. Other status messages are fine: a failed reply is an alert (seen in the run),
  a tool waiting for approval has status text, loading earlier messages is announced.
- **How measured:** a `MutationObserver` on every `aria-live`, `status`, `alert` and `log` region while
  a stand-in model streamed twelve words. Not tested with a real screen reader.
- **Suggested fix:** a polite live region (an `sr-only` status that already exists in the message list
  for history loading) that says "Assistant is replying" when a reply starts and "Reply complete" (or
  the first sentence) when it ends; not the streamed tokens.

## D7. The artifact panel can only be resized by dragging, or by keyboard (2.5.7, moderate)

**Status: open, in the chat area (later).**

- **Criterion:** 2.5.7 Dragging Movements. **Evidence:** the inspection in
  [inspections.md](inspections.md#257) and `facts.dragging["artifact-panel-resize"]` (the keyboard
  alternative works: ArrowLeft widened the panel from 461 to 493 px).
- **Route:** `/chat/$threadId`, with an artifact open on a wide window.
- **What:** The panel's resize handle is the only dragging movement in the application. Its
  alternatives are the keyboard (arrows, Home, End) and a double-click that restores the default
  width. 2.5.7 asks for an alternative a person using a single pointer can use without dragging; the
  keyboard does not serve a person who uses a pointer and cannot drag, and a double-click only resets.
- **Suggested fix:** two buttons in the panel header ("Wider", "Narrower") or a width menu
  (Narrow, Default, Wide) that call the same `onResize`.

## Observations that are not failures of level A or AA

- **Reduced motion is not honoured by some state-driven animations** (inspection of the source, not
  produced by the audit: the audit loads pages at rest and found no animation of more than five
  seconds that survives `prefers-reduced-motion: reduce`). `animate-bounce` on the waiting dots
  (`components/chat/message-list.tsx`), and `animate-pulse` on the tool step, compaction and export
  icons (`tool-steps.tsx`, `compact-thread-dialog.tsx`, `export-menu.tsx`), have no `motion-safe` or
  `motion-reduce` guard, unlike `reply-work.tsx` and `capacity-wait.tsx`. They are loading indicators
  of a second or two, so 2.2.2 does not clearly apply, and 2.3.3 is level AAA; a one-line
  `motion-reduce:animate-none` each would make it consistent. Severity: minor.
- **The "Need help?" card gives no way to contact anyone** (`components/settings/settings-layout.tsx`):
  it says the administrator can reset passwords. Not a WCAG failure (3.2.6 is about where a mechanism
  is, not whether it is useful), but a person who needs help is not shown how.
- **Character-key shortcuts:** with nothing focused, none of 45 single keys changed anything on the
  chat home page, so 2.1.4 raised nothing there.

## What the first run did not cover

The `smoke` matrix: one theme and accent at each view, a second theme and a second accent at desktop,
and the right-to-left pseudo-locale `ar-XB` at desktop (see the report for the exact contexts). Not run:
the real Arabic and Spanish catalogs (`ar`, `es`), the other two accents at every view, the `standard`
and `full` matrices, and the pages that need state this run did not create (`/auth/mfa-setup` for a
person whose role requires two-step verification, a populated public share page, a project page as
the restricted role, which cannot have projects). Run `pnpm a11y:audit --matrix standard` after the
application settles, and the full matrix for a release.

## Every route each finding was seen on

From `evidence.json` of the first run, so that no finding is only an example. `rule` is `findings[].rule`; a finding of severity `review` is something to look at, not a failure.

| Rule | Criterion | Severity | Routes |
| --- | --- | --- | --- |
| `field-boundary-contrast` | 1.4.11 | moderate | `/`, `/admin/audit`, `/admin/backups`, `/admin/branding`, `/admin/compliance`, `/admin/groups`, `/admin/groups/$groupId`, `/admin/health`, `/admin/models`, `/admin/reports`, `/admin/retention`, `/admin/roles`, `/admin/search`, `/admin/settings/authentication`, `/admin/settings/email`, `/admin/settings/general`, `/admin/storage`, `/admin/users`, `/admin/users/$userId`, `/auth/login`, `/auth/verify-email`, `/chat/$threadId`, `/projects`, `/projects/$projectId`, `/settings`, `/settings/attachments`, `/settings/connectors`, `/settings/customization`, `/settings/groups`, `/settings/history`, `/settings/memory`, `/settings/models`, `/settings/sharing` |
| `target-size` | 2.5.8 | moderate | `/`, `/chat/$threadId`, `/projects`, `/projects/$projectId` |
| `text-spacing-clipping` | 1.4.12 | moderate | `/`, `/admin/audit`, `/admin/backups`, `/admin/groups`, `/admin/users`, `/admin/users/$userId`, `/projects`, `/projects/$projectId`, `/settings`, `/settings/attachments`, `/settings/connectors`, `/settings/customization`, `/settings/groups`, `/settings/history`, `/settings/memory`, `/settings/models`, `/settings/sharing` |
| `text-spacing-clipping` | 1.4.12 | review | `/admin/audit`, `/admin/health`, `/admin/models`, `/chat/$threadId`, `/settings`, `/settings/attachments`, `/settings/connectors`, `/settings/customization`, `/settings/groups`, `/settings/history`, `/settings/memory`, `/settings/models`, `/settings/sharing` |
| `text-resize-clipping` | 1.4.4 | moderate | `/`, `/admin`, `/admin/audit`, `/admin/usage`, `/chat/$threadId`, `/settings` |
| `text-resize-clipping` | 1.4.4 | review | `/admin/audit`, `/admin/users/$userId` |
| `text-resize-overlap` | 1.4.4 | serious | `/admin/branding`, `/admin/users/$userId` |
| `text-resize-clipping` | 1.4.4 | serious | `/admin/models` |
| `text-resize-sideways` | 1.4.4 | moderate | `/settings/customization` |
| `text-spacing-overlap` | 1.4.12 | serious | `/settings`, `/settings/customization`, `/settings/groups`, `/settings/history`, `/settings/memory` |
| `reply-not-announced` | 4.1.3 | serious | `/chat/$threadId` |
| `focus-partly-obscured` | 2.4.11 | review | `/chat/$threadId` |
