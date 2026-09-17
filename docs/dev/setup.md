# Setup

## What you need

- **Node 22** and **pnpm 11.18.0** (pinned in `package.json`)
- **Docker**, for PostgreSQL and Redis

## Getting it running

```bash
git clone git@github.com:ncecere/open-chat-interface.git
cd open-chat-interface
pnpm install
cp .env.example .env
```

Generate the two secrets. Do not leave the placeholders:

```bash
# AUTH_SECRET and ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` protects stored provider credentials. **Rotating it makes every
saved credential unreadable** and they must all be entered again, so treat it as
permanent for a given database.

Then:

```bash
pnpm infra:up      # PostgreSQL on 5439, Redis on 6389
pnpm db:migrate
pnpm db:seed       # instance defaults
pnpm dev           # API on 3080, web on 5173
```

Non-default ports are deliberate, so this does not collide with another
PostgreSQL you already run.

The first administrator is created by the API on an empty database, from
`INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`. Leaving the password blank
prints a one-time password to the API's output at first boot, which is the
better choice — it keeps a working password out of your `.env`.

## Demonstration data

For screenshots or a populated interface:

```bash
pnpm db:seed:demo            # people, conversations, usage history
pnpm db:seed:demo -- --clear # remove it again
```

It invents thirteen people at a fictional university, a dozen conversations, and
thirty days of usage. Every row is prefixed `demo-`, so clearing removes exactly
what it added.

**Never run it against an instance anybody uses.** It rewrites the organisation
name and the administrator's personal preferences.

## Working on it

| Command | Does |
| --- | --- |
| `pnpm dev` | Both apps, watching |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm typecheck` | All six packages |
| `pnpm test` | Unit and integration |
| `pnpm build` | Production build |

### Talking to a real model

The seed does not configure a provider, because it has no credentials to use.
Add one through **Providers & Keys** in the interface, then add models from
**Model catalog → Discover**.

Work that does not need a real model — streaming, quotas, most of the interface
— is covered by the test suites, which stub the provider rather than calling
one. See [testing](testing.md).

`docker/compose.dev.yaml` also brings up MinIO and SearXNG, for exercising
S3-compatible storage and web search locally without external accounts.

## When something is wrong

**Ports already in use** — `pnpm infra:down`, then check for another PostgreSQL
on 5439.

**Migrations will not apply** — confirm `DATABASE_URL` points at the container
and not a system PostgreSQL. `docker compose -f docker/compose.dev.yaml logs
postgres` shows whether it is healthy.

**Credentials stopped working after a `.env` change** — you rotated
`ENCRYPTION_KEY`. Re-enter every provider key.

**Types disagree with a schema you just changed** — `packages/db` and
`packages/shared` are built artefacts. `pnpm --filter @oci/db build` after
changing a schema, or the API will typecheck against the previous version.
