# Developing Open Chat Interface

Development is hosted on [GitHub](https://github.com/ncecere/open-chat-interface).
Open pull requests there; see [Contributing](../../CONTRIBUTING.md) for checks
and [Release process](../RELEASING.md) for GitHub Actions and GHCR publishing.

## Contents

1. [Setup](setup.md) — running it locally.
2. [Architecture](architecture.md) — how the pieces fit.
3. [Database](database.md) — schema, migrations, conventions.
4. [API reference](api-reference.md) — every route, generated from the source.
5. [Frontend](frontend.md) — routing, state, styling.
6. [Testing](testing.md) — the four suites and what each is for.
7. [Adding a feature](adding-a-feature.md) — a worked example, end to end.
8. [Screenshots](screenshots.md) — regenerating the documentation images.
9. [Maintainability review](maintainability-review.md) — module boundaries, repeatable structural inventory, and unresolved findings.
10. [Chat performance and application review](chat-performance-review.md) — memoization guardrails, measured render work, and prioritized remaining risks.
11. [Browser performance evidence](browser-performance.md) — isolated production-build comparisons, startup chunk adjustment, measured tradeoffs, and reproducible harness.
12. [Historical verification evidence](email-verification-provenance.md) — provenance limits, safe aggregate inspection, and owner decisions before account-access changes.
13. [Release validation checkpoint](release-validation.md) — full live-service/browser results, corrected onboarding coverage, isolated source-built MinIO, and remaining gates.

## The shape of it

A pnpm workspace with Turborepo:

```
apps/
  api/        Hono on Node 22 — HTTP, auth, model calls, jobs
  web/        Vite + React 19 — the single-page interface
packages/
  config/     shared TypeScript and tooling configuration
  db/         Drizzle schema, migrations, seeds
  shared/     types and Zod schemas used by both apps
```

`packages/shared` is what keeps the two apps honest: a request body is defined
once as a Zod schema, and both the route that validates it and the form that
submits it are typed from the same declaration.

## Choices worth knowing before you start

**No Next.js.** The web app is a plain Vite single-page application served by
Caddy, with the API on the same origin. There is no server-side rendering and no
framework-level data fetching; requests go through `apps/web/src/lib/api-client.ts`.

**The model is resolved on the server.** A client says which model it wants by
slug; the server decides whether that person may use it, applies the quota, and
holds the credentials. A client never sees a provider key.

**Edits and forks are immutable.** Editing a message discards what followed
rather than rewriting history in place, and forking copies to a new thread. The
alternative — mutating a conversation — makes streaming, branching, and export
all harder to reason about.

**Money is integer micro-dollars.** Never a float. Cost arithmetic that has to
survive a quota decision cannot be approximate.

**Settings come from the environment, then the database.** An environment
variable supplies a default; the administrative interface overrides it. Adding a
third precedence layer has been considered and rejected.

## Conventions

- **Biome** for linting and formatting. `pnpm lint:fix` before committing.
- **Comments explain why, not what.** A comment restating the code is noise; one
  explaining why the obvious approach was rejected is what stops somebody
  undoing a deliberate decision.
- **Focused modules.** A file that has become a collection of loosely related
  functions should be split.
- **Tests describe behaviour, not implementation.** `it('refuses a login that
  matches no role')` survives a refactor; `it('calls matchRole')` does not.
