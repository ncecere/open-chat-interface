# Release process

OCI uses semantic versions. A stable tag matching `vX.Y.Z` is the only event
that builds and publishes container images or creates a GitLab Release.

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

5. Merge the release-preparation merge request only after its full GitLab
   pipeline and security reports pass.
6. Confirm the `v*` protected-tag rule allows only release maintainers to create
   tags.

## Publish

Start from a clean, up-to-date default branch:

```bash
git switch main
git pull --ff-only origin main
pnpm release:check
git tag -a v0.1.0 -m "Open Chat Interface v0.1.0"
git push origin v0.1.0
```

The tag pipeline verifies that:

- the tag points to a commit contained in `main`;
- the tag matches every workspace package version;
- the matching changelog section exists;
- the production dependency audit and normal test/security jobs pass.

It then publishes API and web images with the release version and short commit
SHA. After both images exist, it updates `latest` and creates the GitLab Release
using the matching changelog section.

## Verify

- Confirm the tag pipeline is green.
- Confirm both `api` and `web` registry repositories contain `vX.Y.Z`, the short
  SHA, and `latest`, with the same source revision label.
- Confirm the GitLab Release contains the expected notes and links.
- Deploy the versioned images to a staging instance and verify
  `/api/health/ready`, sign-in, one model response, and attachment persistence.
- Record any operational caveat in the release notes before announcing it.

## Failed releases

Do not move or reuse a published version tag. If a defect is found after images
or a GitLab Release have been published, fix it on `main` and issue the next
patch version. A tag pipeline that fails before publishing may be retried after
correcting runner or registry infrastructure, provided the tagged source itself
has not changed.
