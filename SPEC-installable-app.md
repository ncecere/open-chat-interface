# Spec: installable-app (#400)

Module of [SPEC.md](SPEC.md) (v0.14). Depends on nothing. No migration (branding is an instance setting).

## Objective

Phones are where many people use chat. Make OCI installable to a home screen or desktop as an app that opens
without browser chrome, named and coloured as the instance is branded. **No offline mode**: a page needs the
network, and the app says so instead of showing a stale or empty shell. A static manifest cannot carry the
instance's name (deferred in `docs/dev/v0.10-design.md`), so the instance serves it.

## Acceptance criteria

1. **`GET /api/manifest.webmanifest`**, public (no session; the name is already public on the sign-in page,
   `auth-status.ts`), `Content-Type: application/manifest+json`, `Cache-Control: public, max-age=300`, body built
   from Branding: `name` = app name, `short_name` = short name (at most 12 characters, falling back to the first
   12 of the name), `start_url: "/"`, `scope: "/"`, `id: "/"`, `display: "standalone"`, `lang` from the instance
   default language, `theme_color` and `background_color` from the colour theme and accent preset, `icons`.
2. **Icons**: bundled OCI PNGs at 192, 512 and a 512 maskable (new files under `apps/web/public/icons/`, made from
   the existing mark; no image library is added). The instance's uploaded logo replaces them only when
   `branding-assets.ts` can say it is a PNG that is square and at least 512 px; otherwise the bundled icons are
   used. A logo that cannot be used never breaks the manifest.
3. **`index.html`** links the manifest and sets `theme-color` and the Apple web-app meta tags; `DocumentBranding`
   keeps them in step with Branding while the app runs (as it does for the favicon).
4. **Installability is proven, not assumed**: a Chromium test reads `Page.getInstallabilityErrors` over CDP and
   expects none. If the installed Chromium still requires a service worker, add the smallest one that satisfies
   it (a `fetch` handler that passes every request through to the network, caches nothing, handles no
   navigation offline), served from `/`, and allow it in the Caddy and Helm security headers; if not, add none.
   Say which in the module's notes. Whatever is added, a test proves no response is ever served from a cache.
5. **Offline**: with the network down the installed app shows the browser's own error; no offline screen, no
   cached conversations. Documented.
6. **Settings → Customization** gets an *Install* control only when the browser fired `beforeinstallprompt`;
   iOS and desktop-Safari instructions are in the docs (Add to Home Screen), since they have no prompt.
7. **Security**: the endpoint exposes nothing beyond name, colours and icon URLs; the Caddyfile and Helm chart
   security headers (CSP `manifest-src`, `worker-src` if a worker is added) allow it; icon URLs are same-origin.
8. **Docs**: `docs/user` (installing), `docs/admin` (branding: what the manifest takes from it, the PNG rule),
   `docs/OPERATIONS.md` (the headers), docs-site pages in the release step.

## Files touched (expected)

`apps/api/src/routes/manifest.ts` (new), `apps/api/src/services/manifest.ts` (new, pure builder), router
registration, `apps/api/src/services/branding-assets.ts` (a read of the logo's type and size if missing),
`apps/web/index.html`, `apps/web/public/icons/*`, `apps/web/src/components/branding/document-branding.tsx`,
`apps/web/src/routes/settings/customization.tsx`, `docker/Caddyfile`, `deploy/helm/**` (headers only if needed),
tests, docs, CHANGELOG.

## Testing strategy (red first)

Unit: the builder for every branding combination (no logo, SVG logo, PNG too small, PNG good, long name, empty
short name, each accent and theme). Live: the route is public, content type and cache header, branding applied
after a settings change, icon URLs return 200 with `image/png`, a broken logo falls back. Browser (Chromium):
installability errors empty on the seeded app; the manifest loads under the production CSP (run against the
Caddy headers as `docker/Caddyfile` sets them, or assert the header text). If a worker is added: the pass-through
test above. Web unit: the install control only appears after the event.

## Boundaries

Always: public output limited to the listed fields. Never: cache a response, add an offline mode, add a
dependency. Ask first: a service worker that does anything beyond pass-through.

## Success criteria

The acceptance criteria hold, `pnpm lint` and typecheck pass, and the branch installs from a `dev-env`
environment in Chromium (checked by hand, screenshot in the module's report).
