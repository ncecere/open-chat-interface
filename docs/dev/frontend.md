# Frontend

Vite, React 19, TanStack Router and Query, Tailwind 4.

## Where things live

```
apps/web/src/
  routes/       one file per screen
  components/   shared UI, grouped by area
  hooks/        data fetching and shared behaviour
  lib/          api-client, utilities
  providers/    theme, temporary chat
  styles/       tokens.css, global.css
```

## Routing

TanStack Router, declared in `router.tsx`. Routes are typed: a link to a path
that does not exist will not compile.

Administrative routes nest under a parent that supplies the layout, so the path
declared in a child is relative to it. Getting this wrong produces
`/admin/admin/...`, which the type checker will point at.

## Data

TanStack Query throughout. `lib/api-client.ts` is the only module that talks to
the network — it resolves the API against the current origin, which is what
makes the same-origin deployment work without configuration.

Query keys are arrays describing what is fetched:

```ts
queryKey: ['admin', 'users', search, role, status, sort, direction, page]
```

Everything the request depends on belongs in the key. A filter left out produces
a cached result for a query nobody made.

## Styling

Tailwind 4, over CSS custom properties in `styles/tokens.css`.

**Use the tokens, not raw colours.** `bg-[var(--bg-elevated)]`, not
`bg-neutral-900`. The theme system replaces token values; a literal colour
ignores it.

The tokens are organised as:

- **Surfaces** — `--bg-app`, `--bg-elevated`, `--bg-control`
- **Text** — `--text-primary` through `--text-faint`
- **Accent** — `--accent`, `--accent-bright`, `--accent-soft`, configurable per
  instance
- **Capability colours** — one hue per model capability, deliberately outside
  the accent system so a capability stays recognisable when the accent changes

### Contrast

Verify by sampling rendered pixels, not by computing from tokens. Modern CSS
colours do not survive naive parsing — `getComputedStyle` returns `oklch(...)`
unconverted, and treating that as RGB produces numbers that look plausible and
are wrong.

Unit tests can check a token pair without a browser:
`tests/unit/css-test-utils.ts` compiles an element's Tailwind classes, resolves
them against `tokens.css` for each theme and accent, and converts OKLCH
properly before computing the ratio.

## Accessibility

- Every control needs an accessible name. An icon-only button needs
  `aria-label`.
- Targets meet 24×24 CSS pixels. Where a label is deliberately small, padding
  carries the height.
- Colour is never the only signal. Capability pills carry an icon and a label
  as well as a hue.
- A focused or active list item (menus, Select popups, the model picker, the
  command palette) is marked with the `--accent-bright` ring from
  `components/ui/item-focus.ts`, not a background change alone, which is
  invisible in light.
- A dialog traps focus and returns it to its opener on dismissal. Radix only
  does this for a `DialogTrigger`; `DialogContent` (and the command palette)
  use `hooks/use-focus-return.ts`, which also maps a Select or menu item to
  its trigger. When an action removes the focused control's row, focus moves
  to the next row, else the previous one, else the section heading
  (`lib/focus-return.ts`; mark non-`li` rows with `data-focus-row`).

`tests/e2e/accessibility-*.spec.ts` scan for regressions. They are a net, not
proof.
