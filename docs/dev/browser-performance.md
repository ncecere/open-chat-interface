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

## Long conversations (v0.11, item 21)

Before v0.11 opening a conversation loaded and rendered its whole history.
v0.11 loads the latest 100 messages, loads earlier pages as the reader scrolls
up, and renders only the rows near the view once a transcript passes 150 rows
(see `docs/dev/v0.11-design.md`, item 21).

**Fixture.** The browser fixture now seeds `long-conversation`: 2,000 messages
(1,000 turns); every reply has a heading, prose, a table and a highlighted
TypeScript block; every 100th reply a Mermaid diagram and every 250th an HTML
block, each saved as an artifact (10 diagrams, 4 HTML). The first question
carries `LONG-FIXTURE-START`, the last reply `LONG-FIXTURE-END`.

**Runner.** `apps/web/scripts/run-browser-long-conversation.mjs metadata.json
[--origin http://127.0.0.1:4179] [--label name] [--trials 5] [--cpu-throttle 4]
[--gate]` (Playwright's Chromium, run with `pnpm --filter @oci/web exec node
scripts/...`). Real password sign-in, the introduction skipped through the
API, a fresh browser context per trial, 1280×800. It measures:

- **ready**: navigation to the frame after `LONG-FIXTURE-END` is in the page
  (the conversation's end drawn), and the history response's encoded size;
- JavaScript heap (`Performance.getMetrics` after a forced GC) and DOM
  elements once loaded;
- long tasks from navigation to a second after ready;
- **scroll jank**: 40 wheel notches of 1,000 px, 50 ms apart, recording every
  animation-frame interval and the long tasks meanwhile;
- **to the top**: wheel notches of 4,000 px until the first message is in
  view (loading every earlier page after v0.11), its long tasks, then heap
  and DOM again.

`--gate` fails when a median exceeds: ready 2,500 ms, 25,000 DOM elements once
loaded, a 400 ms longest scroll long task, 30,000 DOM elements or 120 MB of
heap at the top. The bounds catch a return to rendering whole transcripts, not
small regressions. The v0.10 build fails three of them (143,894 and 143,898
elements, 137.3 MB); v0.11 passes all.

**Results.** Same fixture and API, the v0.10 web build (`4179`, the branch
before item 21) against v0.11 (`4178`); medians; Apple M4 Pro, headless
Chromium 151, unthrottled network. Throttled rows use DevTools CPU throttling
×4 (roughly a mid-range phone).

| 2,000-message conversation | v0.10 | v0.11 | v0.10, CPU ×4 | v0.11, CPU ×4 |
| --- | ---: | ---: | ---: | ---: |
| Trials | 5 | 5 | 3 | 3 |
| History transferred | 1,054,102 B | 53,381 B | 1,054,102 B | 53,381 B |
| Ready (end of conversation drawn) | 447.5 ms | 135.3 ms | 1,776 ms | 474 ms |
| Messages rendered once loaded | 2,000 | 100 | 2,000 | 100 |
| DOM elements once loaded | 143,894 | 7,743 | 44,597¹ | 7,743 |
| JS heap once loaded | 137.8 MB | 21.8 MB | 89.5 MB¹ | 21.7 MB |
| Long tasks while loading (total / longest) | 1,136 / 570 ms | 90 / 90 ms | 2,069 / 1,292 ms | 608 / 351 ms |
| Scrolling up: frame interval p95 | 16.9 ms | 9.2 ms | 33.5 ms | 9.3 ms |
| Scrolling up: frames over 50 ms | 0 | 0 | 0 | 1 |
| Scrolling up: longest long task | none | none | 57 ms | 89 ms |
| To the first message: long tasks (total) | 0 ms | 0 ms | 43,256 ms | 166 ms |
| At the first message: DOM elements | 143,898 | 792 | 143,898 | 792 |
| At the first message: JS heap | 137.9 MB | 25.1 MB | 137.3 MB | 25.1 MB |

¹ Measured before syntax highlighting had finished: under throttling v0.10 was
still highlighting 2,000 code blocks a second and a half after the end was
drawn, which is what the 43 s of long tasks while scrolling to the top are
(the longest 2.5 s). Unthrottled it had finished.

Reading it: v0.10's cost is all at load, then in highlighting work the reader
meets while scrolling; once everything is drawn, scrolling static DOM is
cheap on this machine. v0.11 draws a twentieth of it, keeps memory flat however
far the reader scrolls (19 earlier pages loaded, 5 to 8 messages rendered at a
time) and keeps frames under 10 ms at p95 throttled. "To the first message"
is the duration of the wheel loop (8.4 s against 11.1 s unthrottled), paced by
the input; the page never stopped the reader to wait for a page.

The existing gates on the same fixture show no regression for ordinary
conversations (one page, every row rendered as before):

| Same fixture, v0.10 → v0.11 | v0.10 | v0.11 |
| --- | ---: | ---: |
| Cold load, composer in DOM (median of 5) | 171.9 ms | 170.1 ms |
| Cold load, model observed (median of 5) | 207.3 ms | 180.2 ms |
| Cold load, JS decoded / transferred | 1,015,821 / 303,440 B | 1,030,267 / 307,953 B |
| Warm 100 messages, send → first text (median of 4 unprofiled) | 245.7 ms | 234.7 ms |
| Warm 100 messages, send → streaming finished | 4,270.8 ms | 4,274.9 ms |
| Warm 100 messages, key → next frame p95 | 8.3 ms | 8.5 ms |
| Warm 100 messages, long tasks during the reply (median) | 0 | 0 (one 50 ms task in one trial) |

One v0.10 cold trial was an outlier (model observed at 1,170 ms); medians are
unaffected. Artifacts: `oci-long-conversation-*` (`summary.json` per run),
`oci-cold-results-lZ9Qfd`, `oci-browser-results-Yl3Tk1` in the temporary
directory. Same limits as above: small local samples, one machine, no real
phone, no network throttling.
