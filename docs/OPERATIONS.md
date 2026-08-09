# Production operations

This guide supplements the deployment overview in [README.md](../README.md).
Test backup and recovery procedures against your own storage and identity
provider configuration before relying on them in production.

## Deploy a released version

Authenticate to the GitLab registry and select an immutable release tag:

```bash
export OCI_VERSION=v0.2.1
export OCI_REGISTRY=registry.gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface
docker login registry.gitlab.it.ufl.edu
export OCI_API_IMAGE="$OCI_REGISTRY/api:$OCI_VERSION"
export OCI_WEB_IMAGE="$OCI_REGISTRY/web:$OCI_VERSION"
```

Create `docker/.env` from `.env.example` or provide the required variables
through your secret manager. Then pull and start without local builds:

```bash
cd docker
docker compose pull api web migrate
docker compose up -d --no-build
docker compose ps
curl --fail "http://localhost:${OCI_PORT:-8080}/api/health/ready"
```

Pin production to `vX.Y.Z`; use `latest` only for evaluation environments.

## Back up

Back up all durable state before an upgrade:

- PostgreSQL contains users, authentication state, settings, provider/model
  configuration, conversations, quotas, and attachment metadata.
- The configured local or S3-compatible storage contains attachment objects.
- Your secret manager contains `AUTH_SECRET`, `ENCRYPTION_KEY`, database
  credentials, and deployment configuration. Losing `ENCRYPTION_KEY` makes
  encrypted provider and integration credentials unrecoverable.

Example PostgreSQL backup for the bundled Compose stack:

```bash
cd docker
docker compose exec -T postgres \
  pg_dump --format=custom --no-owner --username=oci oci > "oci-$(date +%F).dump"
```

For local attachment storage, stop API writes and archive the `oci_storage_data`
volume. For S3-compatible storage, use versioning or the provider's supported
replication/export mechanism; copying only database metadata is insufficient.

Periodically restore both database and object data into an isolated environment
and verify attachment downloads.

## Upgrade

1. Read every changelog entry between the deployed and target versions.
2. Back up PostgreSQL, attachment objects, and deployment secrets.
3. Pull the target versioned API and web images.
4. For a multi-replica deployment, run migrations once before replacing API
   replicas:

   ```bash
   docker compose --profile tools run --rm migrate
   RUN_MIGRATIONS=false docker compose up -d --no-build
   ```

   A single-replica deployment may leave `RUN_MIGRATIONS=true`; startup applies
   migrations under a PostgreSQL advisory lock.
5. Wait for `/api/health/ready`, then verify authentication, chat, search, and
   attachment access.

## Single sign-on roles

A user's role is recalculated from identity-provider claims on every SSO
sign-in, then written to their account.

Two consequences follow, and both surprise administrators who have not met them
before:

- **A role set by hand does not persist.** Promoting an SSO user in the admin
  interface lasts until their next sign-in, at which point the mapping wins.
  Grant a lasting role by changing the group membership in the identity
  provider, or by mapping the group they are already in.
- **A role can go down as well as up.** Someone removed from a mapped group
  drops to whatever still matches, or to the provider's default role.

Where a user matches several mappings, the most privileged one wins. Ordering
the rows differently will not change the outcome; that is deliberate, so a
privilege does not depend on the order somebody happened to add the rows.

To audit what an instance will do before enabling a provider, read its
`claimRoleMappings` and remember that every mapping is evaluated, not just the
first that matches.

## Rollback and recovery

Application images can be rolled back by restoring `OCI_API_IMAGE` and
`OCI_WEB_IMAGE` to the previous versioned tags. Database migrations are forward
only unless a release explicitly documents otherwise. If an upgrade migration
is incompatible with the previous application version, restore the pre-upgrade
PostgreSQL backup and matching attachment snapshot before starting the previous
images.

Do not rotate `ENCRYPTION_KEY` as part of a routine rollback. A different key
cannot decrypt credentials written with the original key.
