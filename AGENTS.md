# Agent notes

Conventions for building and testing are in [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/dev/testing.md](docs/dev/testing.md). This file covers what is specific to working with an
AI agent: running the code on the homelab cluster instead of the laptop.

## Running a branch on the cluster

A branch can be tested as a running copy of the application on the bitop-talos cluster: its own
database, Redis and mail catcher, removed automatically after 8 hours.

1. **Push the branch.** The `Branch images` workflow (`.github/workflows/branch-images.yml`) builds
   `ghcr.io/ncecere/open-chat-interface/{api,web}:dev-<first 12 characters of the commit>` (amd64
   only, about a minute). Wait for it to finish; it runs on every branch push. A branch cut before
   that workflow existed has no images: rebase it onto `main`.
2. **Create the environment** with the `dev-env` tool from the homelab checkout:

   ```sh
   DEVENV=~/homelab/bitop-talos/tools/dev-env/dev-env
   $DEVENV up oci my-name --ref my-branch   # ~35 s; checks the images exist first
   $DEVENV forward oci my-name              # http://localhost:<port>, leave running
   $DEVENV creds oci my-name                # the generated admin email and password
   $DEVENV forward oci my-name --mail       # the mail catcher (every email the app sends)
   ```

   `--ref` takes a branch, tag or commit of this clone, or a release such as `v0.12.0` (published
   chart and images). The kubeconfig is `~/homelab/bitop-talos/kubeconfig`; the tool needs
   `kubectl`, `helm` and Python 3 with PyYAML.
3. **Extend or stop it:** `$DEVENV renew oci my-name --ttl 8h`, `$DEVENV list`,
   `$DEVENV status oci my-name`, `$DEVENV down oci my-name`. Always `down` an environment you are
   done with. Names are 2-20 characters (lowercase letters, digits, dashes).

The tool's own documentation is `tools/dev-env/README.md` in the homelab repo.

## What an environment is, and is not

- It runs in the `dev-oci` namespace only. **Never** deploy, apply or edit anything in
  `open-chat-interface` (production) or in any other namespace to test a change.
- Database: Postgres **18** with pgvector. Production is Postgres 17, so a result that depends on the
  server version needs checking against 17 locally. The API image ships the version 17 client tools,
  so automated backups against an 18 server do not work yet.
- No resource limits and low scheduling priority: the environment yields to production rather than
  being capped, so a heavy test can be slow when the cluster is busy. Do not leave environments
  running.
- Reach it by port-forward only; there is no ingress. The app's address is `http://localhost:<port>`
  (printed by `up`), and it is configured for exactly that address.
- Secrets are generated for each environment and kept in the cluster. Do not print or commit them;
  `creds` shows the admin sign-in on request.
- The cluster is shared with production services: keep tests bounded and remove what you create.

## Not available yet

Only environments exist. The unit, integration and end-to-end suites, the QA walk and the screenshot
capture still run locally (see CONTRIBUTING.md). Running them as Jobs on the cluster is planned.
