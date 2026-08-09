# Open Chat Interface documentation

A self-hosted chat application that puts several AI models behind one
interface, with the controls an institution needs to run it: who may sign in,
which models they may use, how much they may consume, and what is recorded.

## Start here

**If you use OCI to have conversations**, read the
[user guide](user/README.md). It covers sending a message, choosing a model,
attaching a file, searching the web, sharing a conversation, and what the
limits mean when you meet one.

**If you run an OCI instance**, read the
[administrator guide](admin/README.md). It covers the twenty-four
administrative pages, from configuring an identity provider through to
investigating what somebody did last Tuesday.

**If you are working on OCI itself**, read the
[developer guide](dev/README.md). It covers the architecture, the local setup,
the database, the API, and a worked example that adds a feature end to end.

## Operational references

- [Operations](OPERATIONS.md) — deploying, backing up, upgrading, rolling back,
  and getting back in when sign-on fails.
- [Releasing](RELEASING.md) — how a version is prepared, tagged, and published.

## Conventions in these documents

Screenshots come from a demonstration instance belonging to a fictional
institution, seeded by `pnpm db:seed:demo`. Nobody in them is real.

Where a setting has a consequence that is not obvious from its label, the
documentation says what that consequence is. Where a label is self-explanatory,
it is left alone rather than restated.

`docs/research/` holds notes about other products, gathered while making design
decisions. They are not documentation of OCI and should not be read as such.
