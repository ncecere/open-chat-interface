# Scale harness

Generates a realistic dataset, puts OCI under load with k6 and reports latency,
job throughput and database cost. Full documentation, profiles and the
baseline results: [docs/dev/scale-harness.md](../../docs/dev/scale-harness.md).

```sh
tools/scale/run.sh --profile tiny          # about 3 minutes, a smoke check
tools/scale/run.sh --profile small         # about 10 minutes with image builds
tools/scale/run.sh --profile small --replicas 3 --keep
tools/scale/cluster.sh --profile tiny --name scale-t1 --dry-run   # on the cluster: prints every step
```

`cluster.sh` runs the same phases against a `dev-env` environment in `dev-oci`, with a preflight, a
watcher and a verified teardown; read [Large on the cluster](../../docs/dev/scale-harness.md#large-on-the-cluster-v013)
before using it. It is not run from CI.

| File | Purpose |
| --- | --- |
| `run.sh` | Orchestration: build, start `oci-scale`, migrate, generate, warm, load, collect, report, tear down |
| `cluster.sh` | The same on the bitop-talos cluster: preflight, `dev-env up --pg-node`, harness settings, one Job, watcher, teardown |
| `k8s/` | Manifests the run applies (stub model, run Job, Secret and ConfigMaps) and `validate.sh` (kubeconform) |
| `lib/cluster-*.mjs` | The cluster tool's decisions (scope guard, pin, preflight, watcher thresholds), samplers and the environment block; tested in `scripts/scale-cluster-*.test.mjs` |
| `compose.yaml` | The `oci-scale` compose project (PostgreSQL 17 + pgvector + pg_stat_statements, Redis, stub model, API, web, k6) |
| `profiles.mjs` | Dataset sizes, load per scenario, proposed targets |
| `generate.mjs`, `lib/` | Deterministic COPY-based dataset generator |
| `stub/server.mjs` | OpenAI-compatible streaming stub and deterministic embeddings |
| `k6/` | Load scenarios (k6 runs from its official image; it is AGPL and never vendored) |
| `report.mjs` | Collects database and replica measurements, writes `results/<profile>-<date>.{md,json}` |
| `results/` | Run output (git-ignored) and the committed `baseline-*` reports |

Never point the generator at a real deployment: it needs a superuser, refuses
a database that already has people in it unless given `--reset`, and `--reset`
deletes every account and conversation.
