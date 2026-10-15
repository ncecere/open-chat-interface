# Spec: accessibility-report (#401)

Module of [SPEC.md](SPEC.md) (v0.14). Depends on every other module (it reviews the final UI). No migration.

## Objective

Procurement at public institutions asks for a VPAT/ACR. Publish one in the VPAT 2.5 layout for WCAG 2.2 level A
and AA, backed by a real review of every route, and fix what the review finds. **It is a self-assessment by the
OCI project, not a third-party audit**, and says exactly how it was made and what was not done. A claim is
written only where a test or an inspection supports it, and each row names its evidence.

## Method (every item is run and recorded, none assumed)

1. **Automated**: axe-core (`@axe-core/playwright`, already a dev dependency; existing specs
   `accessibility-*.spec.ts`) over every route reachable by an end user and an administrator, in light and dark,
   each accent preset, at desktop, 768 px and 320 px, in `en` and `ar`, signed in as admin, user and restricted.
2. **Keyboard**: scripted keyboard-only walkthroughs of the primary tasks: sign in with and without MFA, start a
   chat, send, stop, approve a tool, open an artifact, search, rename, share, add a project file, change
   settings, an admin task. Record tab order, visible focus (2.4.7), focus not obscured (2.4.11), focus
   appearance (2.4.13), traps (2.1.2), character-key shortcuts (2.1.4), skip link and landmarks (2.4.1), page
   titles (2.4.2), and that every pointer action has a keyboard path (2.1.1).
3. **Accessibility tree**: read the tree (Chromium's `Accessibility.getFullAXTree`, or Playwright
   `ariaSnapshot`) for names, roles, states and values of controls, headings, landmarks, tables, dialogs, menus,
   live regions for streaming replies, tool progress and errors (4.1.3), labels and error association on forms
   (1.3.1, 3.3.1, 3.3.2, 3.3.3), `autocomplete` tokens (1.3.5).
4. **Measured**: a script computes contrast of every foreground/background token pair in every theme and accent
   (1.4.3, 1.4.6 is AAA and not claimed, 1.4.11), the target size of every interactive element (2.5.8, 24 CSS px
   or an exception), text-spacing override (1.4.12), reflow at 320 CSS px and 400% zoom (1.4.10), resize text
   (1.4.4), orientation (1.3.4), reduced motion (2.3.3 is AAA, `prefers-reduced-motion` is still checked).
5. **WCAG 2.2 additions** checked by name: 2.4.11, 2.5.7 dragging movements (the artifact panel resize needs a
   non-drag alternative), 2.5.8, 3.2.6 consistent help, 3.3.7 redundant entry, 3.3.8 accessible authentication
   (MFA code entry allows paste and `autocomplete="one-time-code"`; passkeys; no cognitive test).
6. **Not done, and the report says so**: no person used JAWS, NVDA, VoiceOver, TalkBack or Dragon on it; no
   independent evaluator; user-generated and model-generated content (Markdown, HTML artifacts, SVG diagrams) is
   only as accessible as its author makes it; admin-uploaded logos and documents; third-party documents. The
   report lists these as known limitations and recommends an independent audit where a contract needs one.

## Deliverables and acceptance criteria

1. `scripts/a11y-audit/` and a `pnpm a11y:audit` command that runs steps 1, 3 and 4 against a seeded instance
   and writes `docs/accessibility/evidence.json` (counts and findings per criterion and route, no screenshots).
2. Every defect found is fixed (with a test that fails before the fix) or filed as an issue with the criterion,
   route and severity, and the report rates the criterion accordingly ("Partially Supports" with the issue).
   No axe violation of impact serious or critical remains on any route.
3. `docs/accessibility/acr.md` in the VPAT 2.5 layout: product description, version and date, contact, evaluation
   methods (the list above, with the tools and versions), applicable standards (WCAG 2.2 A and AA; the Revised
   Section 508 and EN 301 549 mapping tables, each row derived from the WCAG rows), terms, then the A and AA
   tables with *Supports / Partially Supports / Does Not Support / Not Applicable / Not Evaluated* and remarks
   that cite the evidence. AAA is "Not evaluated". Everything in the known-limitations list is stated.
4. A docs-site page and a link from the website's accessibility statement; a `docs/RELEASING.md` step: run
   `pnpm a11y:audit` for every minor release and update the report's version, date and any changed row; a test
   that fails when the report's version is more than one minor behind the app's.
5. The existing accessibility e2e suites are extended (not replaced) with the new checks and run in CI.

## Testing strategy

The audit script has unit tests for the contrast and target-size calculators on known colours and boxes. The new
e2e checks fail on a deliberately broken fixture before they are trusted (a negative control per check). The
report's table is generated from `evidence.json` where a row is measured, and written by hand only where it
records an inspection, marked as such.

## Boundaries

Always: every claim cites evidence. Never: claim conformance for a criterion that was not tested; call the report
an audit by a third party; hide a failure by lowering a row to "Not Applicable".
