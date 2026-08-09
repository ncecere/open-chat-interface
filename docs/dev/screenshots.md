# Screenshots

The images in these documents are captured by Playwright against a seeded
instance, so they can be regenerated rather than retaken by hand.

## Regenerating

```bash
pnpm db:seed:demo

E2E_BASE_URL=http://localhost:5173 \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD='...' \
  pnpm docs:shots
```

Writes to `docs/images/`. Roughly forty images, a few minutes.

## How it is arranged

- `apps/web/playwright.screenshots.config.ts` — separate from the end-to-end
  configuration, and never run in CI. A failure here means an image is stale,
  not that the application is broken.
- `tests/screenshots/helpers.ts` — sign-in and the capture helper.
- `tests/screenshots/{admin,user,mobile}.shot.ts` — the captures.

Each project matches only its own file. Both matching everything makes the
mobile project re-photograph every desktop screen at a phone viewport and
overwrite the images under the same names — which looks, in review, like the
whole set was taken on a phone.

## Rules that keep the images usable

**Seed first.** A development database accumulates test artefacts, and
"Reserve inflight" in a screenshot tells a reader nothing good.

**Pin the clock.** `DEMO_NOW` in `seed-demo.ts` fixes every timestamp. Without
it every run rewrites every image with no change worth reviewing.

**Never photograph your own account's preferences.** The demonstration seed
overwrites the administrator's name and personalisation for this reason — the
first run of this harness published a real name and real settings.

**Assert, do not guard.** A capture wrapped in `if (await x.isVisible())`
silently produces no image when a selector stops matching. Assert visibility so
the run fails instead.

**Check the dimensions afterwards:**

```bash
python3 - <<'PY'
import struct, pathlib
for p in sorted(pathlib.Path('docs/images').glob('*.png')):
    w, h = struct.unpack('>II', p.read_bytes()[16:24])
    print(f"{p.name:40} {w}x{h}")
PY
```

Desktop should be 1440×900, mobile 1082×2202. Anything else means a project
matched a file it should not have.

## Adding one

Add a case to the relevant `.shot.ts`, naming it `audience-surface-state`:
`admin-users-bulk-actions`, `user-model-picker`, `mobile-sidebar`. Prefix by
audience so the directory sorts usefully.
