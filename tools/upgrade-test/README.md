# Rolling-upgrade test

Upgrades a published release to this checkout under load, with two API
replicas replaced one at a time (then restarted on the new release, which is
where draining on shutdown is measured), and fails on server errors, lock
stalls, replies cut by a draining replica, cut replies left unrecovered or a
broken previous-release smoke suite. What it proves, how to run it and the
results so far: [docs/dev/rolling-upgrades.md](../../docs/dev/rolling-upgrades.md).

```bash
node tools/upgrade-test/run.mjs                      # previous release -> this source
node tools/upgrade-test/run.mjs --from v0.9.2        # a chosen FROM
node tools/upgrade-test/run.mjs --inject index --expect-fail   # a negative control
node tools/upgrade-test/run.mjs --help
```

| File | Does |
| --- | --- |
| `run.mjs` | The runner: images, stack, seeding, phases, verdict |
| `compose.yaml` | Compose project `oci-upgrade` (ports 127.0.0.1:18480-18481) |
| `seed.mjs` | People through the API; conversations and messages through schema-driven SQL |
| `load.mjs` | The steady load (child process), one event per request |
| `smoke.mjs` | The API smoke suite; also runs on its own against any stack |
| `inject.mjs` | The negative controls (`--inject <case>`) |
| `report.mjs` | Verdict, `report.json` and `report.md` |
| `stub-model.mjs` | The stub OpenAI-compatible model |
