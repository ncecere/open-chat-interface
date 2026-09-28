# Browser performance evidence

## Scope

Production web builds compared the original `fd4cfa0` frontend with `7232bb6`
plus the `initial-shared` chunk grouping in `apps/web/vite.config.ts`. Both used
the **same remediated API**, real password authentication, migrated disposable
PostgreSQL, one available model, and a loopback synthetic provider. This isolates frontend differences;
it is not an old-versus-new backend benchmark. Frontend dependency declarations
matched, and both builds used the same installed dependencies.

Environment: Apple M4 Pro, macOS 26.6, headless Chromium 151, reported viewport
1280×577, unthrottled CPU/network, HTTP loopback Vite previews. No real account
data, Redis, background jobs, external inference, or paid requests were used.

Scripts:

- `apps/api/test/browser-performance/`: owned database, real API/auth, seeded
  histories, synthetic streaming provider; see its README for setup/cleanup.
- `apps/web/scripts/browser-performance-probe.js`: bounded timing/count observers;
  no input text, cookies, or response bodies recorded.
- `apps/web/scripts/run-browser-cold-load.mjs`: fresh browser session for each
  trial, authenticated before navigation, checks uncached JS transfers and typing.
- `apps/web/scripts/run-browser-performance.mjs`: warm both origins, then alternate
  pair order across ten independent 100-message histories. Send the same prompt,
  type 33 trusted key presses during streaming, check draft preservation, 102 final
  messages, >10,000 rendered characters, and zero observed page errors.

The synthetic reply is 19,191 Markdown bytes: 100 chunks, 150 ms initial delay,
40 ms between chunks. Its reported token usage is fabricated fixture data, not
provider tokenization or billing. One excluded smoke request warms the API first.
Each repeat requires a fresh fixture: measured threads are mutated by sending.

## Results after chunk consolidation

Cold-cache results are medians of **five trials per build**, with a warm backend.
All trials used fresh browser sessions and rejected cached JS resources. Password
login is outside the navigation timing. Composer/model observations are DOM
readiness, not a paint metric; successful typing is checked after both are ready.

| Cold navigation | Original | Candidate |
| --- | ---: | ---: |
| Composer observed in DOM | 163.7 ms | 148.4 ms |
| Selected model observed | 178.6 ms | 162.6 ms |
| Initial JS requests | 2 | 3 |
| JS decoded bytes | 1,103,890 | 860,995 |
| JS `transferSize` (includes response overhead) | 311,683 | 258,173 |

Warm-history results below exclude the first, profiled trial of each build:
**four unprofiled trials per build**, 33 key presses per trial. Quantile rows are
medians of per-trial quantiles, not pooled population percentiles.

| Warm 100-message history and long reply | Original | Candidate |
| --- | ---: | ---: |
| Composer observed in DOM | 120.8 ms | 109.1 ms |
| Selected model observed | 201.2 ms | 131.7 ms |
| Send → first response DOM text | 207.2 ms | 256.7 ms |
| Send → streaming UI finished | 4,339.6 ms | 4,332.7 ms |
| Key timestamp → next rAF, p50 | 4.40 ms | 3.25 ms |
| Key timestamp → next rAF, p95 | 9.25 ms | 8.65 ms |
| Long tasks during response | 0 | 0 |

All ten streaming trials preserved the next-turn draft and rendered the same
17,111 text characters. **The candidate's first response DOM text was about
50 ms later**; that difference was not eliminated by chunk consolidation and its
cause is not established. Do not present these changes as uniformly faster.
Typing was already responsive on this machine; this is not evidence of a large
user-perceived input-latency improvement.

One profiled trial per build, restricted to the renderer thread between
`oci-send` and `oci-stream-finished`, provides supporting work measurements:

| Trace category | Original | Candidate |
| --- | ---: | ---: |
| FunctionCall duration | 591.60 ms | 440.31 ms |
| EventDispatch duration | 224.28 ms | 64.21 ms |
| Layout duration | 58.83 ms | 63.61 ms |
| UpdateLayoutTree duration | 34.45 ms | 41.62 ms |
| Paint duration | 117.40 ms | 114.88 ms |

Categories may overlap/nest: **do not sum them as total CPU time**. These are
single representative traces, not statistical estimates. Layout did not improve.
Key timestamp-to-rAF is **not INP, FPS, or a completed-paint guarantee**. The
observer and automation have overhead. There was no mobile/slow-device/network,
production provider latency, load, memory/RSS, or long-running leak measurement.

## Measured regression and adjustment

The first lazy-route build (`7232bb6`) produced **58 initial JS requests**. A
separate five-trial cold comparison measured median composer DOM readiness at
165.7 ms original versus 193.5 ms candidate, despite smaller downloaded code.
Grouping only already-initial, shared modules reduced the graph to three files;
the fresh-session repeat above reversed that local startup regression. Deferred
admin/settings sources still pass the manifest/source-map exclusion gate.
Authenticated browser smoke checks also loaded `/admin/models` (fixture model
visible) and `/settings` (Account/Security & Access) without observed page errors.

The earlier phase-eight static-size comparison used eager checkpoint `f056f41`,
not original `fd4cfa0`, and gzip levels differ from browser transfer accounting.
Do not mix those byte counts with this table.

## Artifacts and limits

Local raw artifacts (not credentials) were written to temporary directories:

- Initial warm: `oci-browser-results-UgOS0d`.
- Initial cold: `oci-cold-results-VGFa3H`.
- Consolidated cold: `oci-cold-results-clhQR6`.
- Consolidated warm and two traces: `oci-browser-results-LpTozK`.

Each runner writes `summary.json`; warm runs also write per-trial observations
and Chrome trace JSON. Temporary artifacts are not durable release attachments;
rerun the committed harness to reproduce. All measurements were successful,
small local samples, not production SLO or release approval. Full authenticated
browser/service/security/migration/deployment gates remain separate.
