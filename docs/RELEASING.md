# Release process

OCI uses semantic versions. GitHub Actions' **Publish containers** workflow
builds and publishes API and web images to GHCR on a stable `vX.Y.Z` tag push,
or on manual dispatch with an existing stable tag. Pull requests and `main`
pushes validate only; they do not publish images.

The workflow does not create GitHub Releases.

## Prepare

1. Create a release-preparation branch from current `main`.
2. Set the same version in the root and all workspace `package.json` files.
3. Move completed entries from `Unreleased` into a dated `CHANGELOG.md` section
   named `## [X.Y.Z] - YYYY-MM-DD`.
4. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm release:check
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm licenses:check
   ```

5. Check the release's database work (v0.11 three-phase migrations,
   [Database](dev/database.md#three-kinds-of-migration)):

   - **A new minor release** adds an entry to `packages/db/releases.json`
     naming its first pre-deploy migration (`firstMigration`), so the
     migrator and the preflight know which release each migration belongs
     to. A patch release adds no entry.
   - **Required earlier work.** If the release relies on an earlier
     release's background migration or post-deploy step being finished (a
     `NOT NULL` on a backfilled column, dropping a fallback, a query that
     needs an index), list it under `requires` in that entry. The migrator
     then refuses the release's pre-deploy migrations until it is finished,
     naming it. Name only work at least one release older: the previous
     release must have shipped and scheduled it, or nobody can finish it
     without skipping your release.
   - **Changelog.** State the required work and what an operator does
     ("finish background migration X on v0.N before upgrading"), every
     post-deploy step and the index it builds, and any background migration
     the release schedules. `node dist/scripts/upgrade-check.js` against a
     copy of a previous-release database shows what an operator will see.
   - **Keep** every background-migration definition and post-deploy step of
     earlier releases: an instance that never ran `migrate --post` must still
     be able to finish them.
   - `pnpm lint:migrations` and the rolling-upgrade test (which runs
     `migrate --post` and waits for background migrations) pass.
6. Merge the release-preparation pull request only after GitHub Actions CI
   passes. Review audit findings and any skipped live tests.
7. Configure branch protection or a ruleset requiring review and CI on `main`,
   and restrict creation, updates, and deletion of `v*` tags to release
   maintainers where your GitHub plan supports it. These are recommendations,
   not confirmation that protection is configured; verify the settings before
   releasing.

## Refresh the documentation

Screenshots and the API reference are committed, so they drift silently between
releases. Regenerate both while preparing one:

```bash
pnpm docs:api
pnpm db:seed:demo          # a presentable instance, not your own data
pnpm docs:shots            # needs E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD
```

Review the resulting diff. An image that changed for no reason you can name is
worth understanding before it is committed.

## Publish

Start from a clean, up-to-date default branch:

```bash
git switch main
git pull --ff-only origin main
pnpm release:check
# Replace X.Y.Z with the next prepared version; never recreate an existing tag.
git tag -a vX.Y.Z -m "Open Chat Interface vX.Y.Z"
git push origin vX.Y.Z
```

**Publish containers** verifies that:

- the tag points to a commit contained in `main`;
- the tag matches the root and every workspace package version;
- the matching changelog section exists;
- reusable validation passes against the checked-out tagged source, not merely
  against the current `main` checkout.

Validation uses Node 22 and pnpm 11.18.0 for lint, type checking, builds,
unit/integration tests, coverage floors, live PostgreSQL/Redis/Mailpit/S3
(VersityGW) and browser tests, production dependency auditing, and license
checks. In CI the S3 and backup suites fail rather than skip when their
services are missing ([Testing](dev/testing.md#s3-in-ci)).

Images are published for `linux/amd64` only to:

- `ghcr.io/ncecere/open-chat-interface/api`
- `ghcr.io/ncecere/open-chat-interface/web`

Each image receives the version tag (for example, `v0.4.1`) and an eight-character
commit SHA tag. The workflow uses `GITHUB_TOKEN` with `packages:write`; no saved
PAT is required for CI. Both GHCR packages are public; the
workflow does not change package visibility, so check it after the first
publication of a new package.

`latest` is promoted only after both images succeed and the release tag is the
newest stable tag on `main`. Publishing an older tag does not roll `latest`
back. Each run first pushes a candidate by digest only, with provenance and an
SBOM. Version/SHA aliases are assigned only after verifying platform and OCI
labels. Existing matching aliases retain their original digest even if a rebuilt
candidate differs; conflicts fail rather than overwriting a release. Untagged
candidate versions can remain after retries; any package cleanup must preserve
release, SHA and `latest` tags.

Version/SHA immutability assumes this serialized workflow is the only registry
writer. GHCR tags themselves remain mutable; the inspect/create sequence is not
an atomic create-only operation. Restrict other writers and pin deployments by
manifest digest when content identity must be registry-independent.

The two `latest` aliases update sequentially, not atomically. A registry failure
can leave one updated and the other unchanged even though both versioned images
exist. Retry publication for the unchanged tag to repair promotion; deploy pinned
version/digest pairs rather than relying on synchronized `latest` updates.

### Seed GHCR from the existing v0.4.1 tag

The existing `v0.4.1` commit has no GitHub publish workflow. Do not move, delete,
or recreate the tag to add one. After these workflows are merged into `main`:

1. Open **Actions → Publish containers → Run workflow** on GitHub.
2. Select `main` as the workflow ref and set the string input `tag` to `v0.4.1`.
3. Run the workflow. It resolves the existing tag, validates that tagged source,
   and publishes the images under the same gates as a tag-push release.

The same manual dispatch can retry an existing stable release tag. Run it from
`main`; the `tag` input selects the source to validate and publish.

## Verify

- Confirm **Publish containers** and its validation jobs are green; inspect
  skipped live tests.
- Confirm both GHCR packages are public and contain `vX.Y.Z` and the
  eight-character SHA tag with the expected source revision label.
- For the newest stable tag on `main`, confirm `latest` points to that release
  for both images. An older release must leave `latest` unchanged.
- If a GitHub Release page is needed, create it separately with the matching
  changelog notes and image links; the workflow does not create one.
- Deploy the versioned images to a staging instance and verify
  `/api/health/ready`, sign-in, one model response, and attachment persistence.
- Record any operational caveat in the release notes before announcing it.

## Failed releases

Do not move or reuse a published version tag. If a defect is found in released
source, fix it on `main` and issue the next patch version. Infrastructure failures
can be retried for the unchanged tag, including after only one image was
published: matching aliases are retained and missing aliases are repaired from
the verified existing digest (or the new candidate for a new release). Investigate
metadata conflicts rather than deleting or overwriting release images to bypass
the guard. `latest` is not promoted unless both image jobs succeed.
