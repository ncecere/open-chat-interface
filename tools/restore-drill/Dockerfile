# PostgreSQL 17 with pgvector and pgBackRest, for the restore drill
# (tools/restore-drill/run.mjs). This is the image docs/admin/external-database-backup.md
# tells Compose users to build for themselves; OCI does not ship it.
#
# pgBackRest comes from the PGDG apt repository that the base image already
# configures (Debian's own package is too old for PostgreSQL 17). Licences:
# PostgreSQL and pgvector (PostgreSQL licence), pgBackRest (MIT).
ARG BASE=pgvector/pgvector:pg17
FROM ${BASE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/pgbackrest /var/log/pgbackrest /etc/pgbackrest \
 && chown -R postgres:postgres /var/lib/pgbackrest /var/log/pgbackrest

# A local repository on a volume, encrypted like a real one should be. The
# passphrase is a throwaway value for this drill, not a secret.
#
# pg1-user: the image's superuser is the role POSTGRES_USER names (oci), and
# there is no role called postgres, which pgBackRest would otherwise try.
RUN printf '%s\n' \
  '[global]' \
  'repo1-path=/var/lib/pgbackrest' \
  'repo1-cipher-type=aes-256-cbc' \
  'repo1-cipher-pass=restore-drill-only-passphrase' \
  'repo1-retention-full=2' \
  'process-max=2' \
  'start-fast=y' \
  'log-level-console=info' \
  'log-level-file=info' \
  '' \
  '[oci]' \
  'pg1-path=/var/lib/postgresql/data' \
  'pg1-user=oci' \
  > /etc/pgbackrest/pgbackrest.conf \
 && chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
