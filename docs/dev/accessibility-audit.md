# Accessibility audit

`pnpm a11y:audit` is the review behind the [accessibility conformance
report](../accessibility/acr.md) (#401). It drives Chromium through Playwright against a
running, seeded instance, runs the automated, keyboard, accessibility-tree and measured checks of
the report's method, and writes `docs/accessibility/evidence.json`: counts and findings per
criterion and route, with no screenshots, no page text and no secrets. `pnpm a11y:report`
turns that into the report. It is a self-assessment, not a third-party audit, and the report
says what it did not do (nobody used a screen reader or voice control on it).

It adds no dependency: it uses the Playwright and axe-core that `apps/web` already has as
development dependencies.

## Run it

Use a disposable instance, never production. The audit changes it while it runs and puts the
settings back: the accent colour (for each accent preset), the enabled languages, the email
verification requirement (for the moment an account is made). It also leaves behind fresh
accounts (`a11y-<role>-…@example.test`), one provider with two models named "A11y audit", a
group and some conversations and projects.

1. Start an instance as CI's browser step does ([Testing](testing.md#end-to-end)): the API with
   a seeded database and `RATE_LIMIT_AUTH_PER_MINUTE=100000`, and the web app built **with the
   pseudo-locales** and served by `vite preview`:

   ```bash
   VITE_OCI_PSEUDO_LOCALES=1 pnpm --filter @oci/web build
   pnpm --filter @oci/web exec vite preview --host 127.0.0.1 --port 4173
   ```

   Without `VITE_OCI_PSEUDO_LOCALES=1` the right-to-left pseudo-locale `ar-XB` is not offered
   and the audit records the language as skipped, not as passed. The real languages (`es`, `ar`)
   are switched on through the administration API for the run.
2. Chromium must be installed for Playwright (`pnpm --filter @oci/web exec playwright install
   chromium`).
3. Run, with the same variables the end-to-end suite uses:

   ```bash
   E2E_BASE_URL=http://127.0.0.1:4173 \
   E2E_ADMIN_EMAIL=admin@example.test E2E_ADMIN_PASSWORD='…' \
     pnpm a11y:audit [--base-url URL] [--out DIR] [--matrix smoke|standard|full]
   ```

   The seeded administrator is used only to create the accounts and change the settings above.
   The audit is run as three fresh accounts (administrator, user, restricted) and signed out; the
   seeded administrator is never audited as, and never enrolled in two-step verification.

   | Option | Meaning |
   | --- | --- |
   | `--matrix smoke` | The baseline plus one step along each dimension: minutes. For trying the tool. |
   | `--matrix standard` (default) | Every theme with every accent at desktop; every view in both themes; every other language at desktop and at 320 px: tens of minutes. |
   | `--matrix full` | Every combination of role, theme, accent, view and language: hours. |
   | `--roles`, `--themes`, `--accents`, `--views`, `--languages` | Comma lists that replace the defaults (`anonymous,admin,user,restricted`; `light,dark`; `neutral,blue,violet,emerald`; `1280,768,320,zoom400,text200,reduce`; `en,ar-XB,ar`). |
   | `--routes REGEX` | Only routes whose path matches. |
   | `--only pages,walkthroughs,global` | Run only those parts. |
   | `--concurrency N` | Browser contexts at once (default 3). |

   The profile and the dimensions that ran are written into `evidence.json` and the report, so a
   reader can see what was covered.
4. Read the result, then regenerate the report:

   ```bash
   pnpm a11y:report --version X.Y.Z            # a draft: headed "DRAFT: generated from a run against an unfinished build"
   pnpm a11y:report --version X.Y.Z --final    # no DRAFT header: only after the final audit of a settled build
   ```

## What it does

| Part | What | Criteria |
| --- | --- | --- |
| axe | `@axe-core/playwright` with the WCAG 2.2 A and AA tags, on every route a role can reach, in every context | many |
| Contrast | Every rendered text colour pair over the colour of its element and ancestors, read from computed styles (`oklch`, `color-mix` and alpha included), judged by `lib/colour.mjs` | 1.4.3 |
| Non-text contrast | The edge of every field and the glyph of every icon-only control; the focus indicator in the walkthroughs | 1.4.11 |
| Target size | The box of every pointer target, with the spacing, inline and user-agent exceptions (`lib/target-size.mjs`) | 2.5.8 |
| Text spacing | The 1.4.12 override injected; newly clipped or overlapping text (`lib/text-spacing.mjs`) | 1.4.12 |
| Resize text | The root font size doubled; the same clipping and overlap check | 1.4.4 |
| Reflow | 320 CSS px wide, and 320 by 256 px at device scale 4 (400% zoom of 1280 by 1024) | 1.4.10 |
| Motion | Long and endless animations, with and without `prefers-reduced-motion` | 2.2.2 (and 2.3.3 as a by-product) |
| Forms | Labels, error association, `autocomplete` tokens on pages that collect the person's own details, paste into password and code fields | 3.3.1, 3.3.2, 1.3.5, 3.3.8 |
| Document | Title, language and direction, landmarks, headings, zoom allowed | 2.4.2, 3.1.1, 1.3.1, 2.4.1, 2.4.6, 1.4.4 |
| Accessibility tree | `Accessibility.getFullAXTree`: names of controls, and the state attribute of custom controls | 4.1.2 |
| Orientation | The chat page in portrait and landscape, and the manifest | 1.3.4 |
| Keyboard walkthroughs | The primary tasks, with `page.keyboard` only; every tab stop judged for a visible focus indicator (2.4.7), its contrast (1.4.11), cover by fixed or sticky content (2.4.11), traps (2.1.2); the skip link (2.4.1); dialog focus; character-key shortcuts (2.1.4); live regions while a reply streams, fails and stops (4.1.3); the artifact panel's non-drag resize (2.5.7); consistent help (3.2.6); the second step's paste, token and absence of a puzzle (3.3.8, 3.3.7) | 2.1.1, 2.4.x, 2.1.2, 2.1.4, 4.1.3, 2.5.7, 3.2.6, 3.3.7, 3.3.8 |
| Roles | Each role is kept out of what it may not open; old addresses still land somewhere | – |

The tasks that need a model (send, stop, approve, artifact) run against a stand-in
(`scripts/a11y-audit/lib/stand-in.mjs`) that sends the same events, because the audit's
instance has no working provider. A reply that really fails (the provider is a closed port) is
used to see whether an error is announced.

What it cannot see is written beside each check in `evidence.json` (`checks.<name>.limits`)
and in the report. Three things to keep in mind: a check passing is not conformance; axe finds
about a third of what WCAG asks; and nobody has used a screen reader on the result.

## Routes

`scripts/a11y-audit/routes.json` lists every path in `apps/web/src/router.tsx` with who can
reach it (`public`, `end-user`, `admin`), the fixture a parameter needs, and whether the page
collects the person's own details (`ownDetails`, for 1.3.5). A test
(`scripts/a11y-audit-routes.test.mjs`) fails when the router has a path that the list lacks, and
when the list has a path the router lacks (unless it is marked `synthetic`, with a reason). **When
you add a page, add it to `routes.json`.**

## Findings, inspections and the report

- `evidence.json` is what was measured. The report cites it by key (`criteria["1.4.3"]`,
  finding ids `F001`…).
- `findings.md` records every defect the audit found: criterion, route, severity, evidence and a
  suggested fix. A test fails when a finding in `evidence.json` is missing from it.
- `inspections.md` holds what a person looked at (the media search that makes 1.2.x Not
  Applicable, say), one block per criterion with its method and date. The generator marks each
  as an **Inspection**; an inspection never lowers a measured failure. Repeat an inspection
  when the code it is about changes.
- `acr.md` is generated. A measured row comes from the evidence; a row that only an inspection
  can settle comes from `inspections.md`; a row with neither is Not Evaluated. Passing automated
  checks turn a criterion into "Supports" only for the criteria in `lib/mappings.mjs`
  (`DECISIVE`), where the measurement is the test; for the rest a clean automated run is a remark,
  not a conformance claim. The Revised Section 508 and EN 301 549 tables are derived from the
  WCAG rows (also `lib/mappings.mjs`). `scripts/a11y-audit-docs.test.mjs` fails when `acr.md` is
  not what the generator makes from the committed inputs, so it cannot be edited by hand.

## The checks are tested, and can fail

Unit tests (`node --test scripts/a11y-audit-*.test.mjs`, run by CI with the other scripts)
cover the calculators on known colours and boxes (contrast, target size, text spacing,
autocomplete), the matrix, the routes, the evidence, the report and the version check.

Every automated check is also run against a fixture with a known defect
(`scripts/a11y-audit/fixtures/broken.html`: light grey text, two 10 px buttons 4 px apart, a
removed focus outline, an unlabelled input, a 600 px block at a 320 px window, a title box that
clips under text spacing, a trap, a link under a fixed bar, an empty button, a checkbox with no
state, endless motion, a refused paste, no title, language or landmark, zoom switched off) and
must flag it; and against `clean.html`, which must not be flagged:

```bash
pnpm --filter @oci/web exec playwright test tests/e2e/accessibility-audit-controls.spec.ts
```

This spec needs no server and runs with the other accessibility specs in CI. If you add a check,
add its defect to `broken.html` and its negative control to the spec first, and watch it fail.
(`broken.html` is excluded from `biome` because biome's own accessibility rules flag it.)

## Keeping the report current

The report's version must not be more than one minor release behind `apps/api/src/version.ts`
(a test). [Releasing](../RELEASING.md) has the step: run the audit for every minor release,
regenerate and commit the report, link it from the docs.
