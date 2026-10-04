# Scale harness results: `small`, 2026-10-04

Commit `d31bfe1`; 1 API replica(s) behind the web proxy; stub model: first token after 500 ms, 50 tokens/s, 250 tokens a reply.

Hardware: Apple M4 Pro, 48 GiB memory, macOS 26.6; Docker: 12 CPUs, 7 GiB memory. Everything (PostgreSQL, Redis, API, web, stub, k6) shares that machine.

Load: sign-in storm at 20/s for 45 s (after a 15 s ramp), then 180 s of mixed load with 20 browsing, 10 chatting, 5 searching, 4 project-chatting, 1 admin and 1 job-running virtual users, each a signed-in person with think time.

## Dataset

| Table | Rows |
| --- | ---: |
| user | 1,000 |
| account | 1,000 |
| session | 547 |
| user_preference | 753 |
| project | 800 |
| thread | 50,000 |
| message | 500,000 |
| attachment | 12,487 |
| share_link | 1,213 |
| project_file_index | 4,552 |
| project_file_chunk | 54,189 |
| audit_log | 125,000 |
| usage_event | 125,000 |
| usage_record | 43,921 |
| project_file_embedding | 49,682 |
| storage_usage | 865 |
| quota_denial | 348 |

Generated in 49 s (COPY phase 5 s at 160,989 rows/s, 100,465 messages/s; 19,667 rows/s including derived tables, index rebuilds and VACUUM). Database after generation: 1.72 GiB. Embeddings: 1536 dimensions.

## Latency by scenario (ms)

| Scenario | p50 | p95 | p99 | n | Target (p95) | Met | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: |
| Sign-in storm (one sign-in) | 60 | 65 | 70 | 1,107 |  |  | 0.00% |
| Sidebar (parallel requests) | 5 | 10 | 121 | 1,310 | < 300 | yes | 0.00% |
| Sidebar: conversation list request | 4 | 9 | 118 | 1,310 |  |  | 0.00% |
| Open a conversation | 3 | 5 | 9 | 1,310 | < 300 | yes | 0.00% |
| Reply start added by OCI (chat) | 18 | 142 | 155 | 169 | < 1000 | yes | 0.00% |
|   … history under 20k characters | 18 | 141 | 156 | 152 |  |  | 0.00% |
|   … history 20k–150k characters | 19 | 55 | 128 | 17 |  |  | 0.00% |
| Reply start added by OCI (project chat) | 21 | 767 | 773 | 67 | < 1000 | yes | 0.00% |
|   … large project: passages searched | 753 | 773 | 777 | 16 |  |  | 0.00% |
|   … small project: files included whole | 19 | 156 | 270 | 51 |  |  | 0.00% |
| Chat: time to first byte | 18 | 136 | 152 | 169 |  |  | 0.00% |
| Chat: whole reply (stub streams ~5 s) | 5,509 | 5,666 | 5,695 | 169 |  |  | 0.00% |
| Chat: relay after the last token | 10 | 36 | 67 | 169 |  |  | 0.00% |
| Project chat: whole reply | 5,513 | 6,259 | 6,264 | 67 |  |  | 0.00% |
| Keyword search (all terms) | 18 | 79 | 150 | 257 | < 1000 | yes | 0.00% |
| Keyword search: common word | 54 | 87 | 172 | 77 |  |  | 0.00% |
| Keyword search: medium word | 18 | 64 | 70 | 101 |  |  | 0.00% |
| Keyword search: rare word | 15 | 61 | 152 | 51 |  |  | 0.00% |
| Keyword search: two words | 6 | 8 | 8 | 28 |  |  | 0.00% |
| Admin pages (all) | 24 | 117 | 126 | 96 |  |  | 0.00% |
| Admin: overview | 116 | 147 | 170 | 12 |  |  | 0.00% |
| Admin: usage-overview | 77 | 83 | 84 | 12 |  |  | 0.00% |
| Admin: usage-spend | 83 | 96 | 96 | 12 |  |  | 0.00% |
| Admin: usage-limits | 3 | 5 | 6 | 12 |  |  | 0.00% |
| Admin: usage-storage | 10 | 18 | 24 | 12 |  |  | 0.00% |
| Admin: users | 4 | 5 | 6 | 12 |  |  | 0.00% |
| Admin: audit | 6 | 13 | 16 | 12 |  |  | 0.00% |
| Admin: health | 27 | 35 | 35 | 12 |  |  | 0.00% |

"Reply start added by OCI" is the time from sending the message to the stub model receiving the request: everything OCI does before the model is asked. The stub's own first-token delay is excluded; the relay of tokens back is measured separately ("relay after the last token").

## Background jobs under load

| Job | Runs | Items | p50 run (ms) | p95 run (ms) | Items per busy second | Items per minute |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| projects.index-files (files) | 28 | 448 | 15 | 261 | 212.5 | 149 |
| projects.embed-passages (passages) | 28 | 11,235 | 2,065 | 3,004 | 227.0 | 3745 |

## Retention under load

| Job | Duration (ms) | Rows deleted |
| --- | ---: | ---: |
| retention.usage-events | 31 | 19,359 |
| retention.audit-log | 36 | 15,719 |

While they ran: sidebar p95 18 ms, conversation opening p95 7 ms, errors 0.00%.

## Database

Size after the main run: 1.83 GiB.

| Table | Rows | Total | Table | Indexes | Dead tuples |
| --- | ---: | ---: | ---: | ---: | ---: |
| message | 500,609 | 905 MiB | 367 MiB | 250 MiB | 0.13% |
| project_file_embedding | 58,149 | 493 MiB | 9 MiB | 6 MiB | 0.00% |
| project_file_chunk | 60,917 | 256 MiB | 78 MiB | 35 MiB | 0.00% |
| audit_log | 125,000 | 61 MiB | 45 MiB | 16 MiB | 0.00% |
| attachment | 12,487 | 57 MiB | 7 MiB | 2 MiB | 0.04% |
| usage_event | 125,000 | 49 MiB | 28 MiB | 21 MiB | 0.06% |
| thread | 50,000 | 20 MiB | 11 MiB | 9 MiB | 0.50% |
| usage_record | 43,921 | 19 MiB | 9 MiB | 9 MiB | 0.23% |
| project_file_index | 4,552 | 1 MiB | 0 MiB | 0 MiB | 0.00% |
| session | 1,658 | 1 MiB | 0 MiB | 0 MiB | 0.00% |
| account | 1,000 | 1 MiB | 0 MiB | 0 MiB | 0.00% |
| share_link | 1,213 | 1 MiB | 0 MiB | 0 MiB | 0.00% |

| Largest indexes | Table | Size | Scans |
| --- | --- | ---: | ---: |
| message_text_search_idx | message | 154 MiB | 60 |
| message_pkey | message | 36 MiB | 11,849 |
| message_thread_position_idx | message | 32 MiB | 18,766 |
| project_file_chunk_search_idx | project_file_chunk | 30 MiB | 0 |
| message_parent_idx | message | 15 MiB | 0 |
| usage_event_pkey | usage_event | 9 MiB | 1,409 |
| audit_log_pkey | audit_log | 9 MiB | 0 |
| usage_event_user_occurred_idx | usage_event | 8 MiB | 303 |
| message_change_seq_idx | message | 8 MiB | 0 |
| project_file_embedding_pk | project_file_embedding | 6 MiB | 1,720,017 |

### Named queries (pg_stat_statements, main run)

| Query | Calls | Mean (ms) | Max (ms) |
| --- | ---: | ---: | ---: |
| Conversation search (message GIN index, filtered to one person) | 257 | 27.18 | 87 |
| Project keyword retrieval (ts_rank_cd over one project) | 16 | 606.10 | 675 |
| Project vector retrieval (pgvector exact scan over one project) | 16 | 8.98 | 14 |
| Embedding backlog (passages without an embedding) | 28 | 44.25 | 49 |
| Sidebar conversation list | 1,330 | 0.10 | 1 |
| Conversation messages | 2,976 | 0.07 | 2 |
| Usage reports (usage_event aggregates) | 547 | 2.21 | 36 |
| Message counts by time (admin overview) | 48 | 62.92 | 119 |
| Quota admission (usage in the policy window) | 2,811 | 0.06 | 1 |

### pgvector exact scans (EXPLAIN ANALYZE after the main run)

| Scope | Passages scanned | Files | Median (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| Project with the most passages | 2,751 | 20 | 18.0 | 72.0 |
| Project with the #2 most passages | 2,635 | 19 | 18.0 | 40.1 |
| Project with the #3 most passages | 2,555 | 20 | 16.8 | 34.2 |
| Project with the #4 most passages | 2,466 | 20 | 16.0 | 28.3 |
| Project with the #5 most passages | 2,422 | 19 | 16.5 | 23.1 |
| Every embedding, no project filter (top 10) | 60,917 | | 247.2 | |

### Top queries by total time (pg_stat_statements, main run)

| # | Calls | Total (ms) | Mean (ms) | Max (ms) | Query |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 11 | 7,304 | 664.0 | 675 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 2 | 257 | 6,985 | 27.2 | 87 | `with hits as materialized ( select m.id, m.thread_id, m.role, m.position, ts_rank(to_tsvector($17::regconfig, jsonb_path_query_array("m"."parts", $18::jsonpath)), $1::tsquery) as rank from message m join thread t on t.id` |
| 3 | 3 | 1,490 | 496.6 | 503 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 4 | 12 | 1,338 | 111.5 | 119 | `select to_char(date_trunc($2, "created_at"), $3), count(*) from "message" where "message"."created_at" >= $1 group by date_trunc('day', "message"."created_at") order by date_trunc($4, "message"."created_at")` |
| 5 | 28 | 1,239 | 44.2 | 49 | `select c.attachment_id, a.user_id, a.organization_id, c.ordinal, c.content from project_file_chunk c join attachment a on a.id = c.attachment_id left join "project_file_embedding" e on e.attachment_id = c.attachment_id a` |
| 6 | 2 | 904 | 451.8 | 458 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 7 | 12 | 894 | 74.5 | 80 | `select to_char(date_trunc($3, occurred_at at time zone $1), $4) as day, sum(message_count) as messages, count(distinct user_id) as active_users from usage_event where occurred_at >= $2::timestamptz and pending = $5 group` |
| 8 | 24 | 665 | 27.7 | 36 | `select coalesce(sum("message_count"), $2)::bigint, coalesce(sum("tokens_in"::bigint + "tokens_out"::bigint), $3)::bigint, coalesce(sum("cost_micros"), $4)::bigint, count(distinct "user_id")::int from "usage_event" where ` |
| 9 | 12 | 591 | 49.3 | 54 | `select count(*) from "message" where "message"."created_at" >= $1` |
| 10 | 12 | 567 | 47.3 | 50 | `select count(*) from "message" where ("message"."created_at" >= $1 and "message"."created_at" < $2)` |
| 11 | 12 | 560 | 46.7 | 52 | `select count(*) filter (where role = $2) as sent, count(*) filter (where web_search_used = $3) as searched, count(*) filter (where status = $4) as errored, count(*) filter (where status = $5) as cancelled from message wh` |
| 12 | 12 | 524 | 43.6 | 49 | `select "model_slug", count(*)::int from "message" where ("message"."created_at" >= $1 and "message"."status" = $2 and "message"."model_slug" in ($3, $4, $5, $6, $7)) group by "message"."model_slug"` |

### Slowest API routes by total time (OCI metrics, all replicas)

| Route | Requests | Mean (ms) |
| --- | ---: | ---: |
| `POST /api/auth/*` | 1,152 | 78.2 |
| `POST /api/admin/lifecycle/jobs/:name/run` | 56 | 920.6 |
| `POST /api/chat` | 238 | 72.5 |
| `GET /api/threads/:id` | 264 | 32.4 |
| `GET /api/threads` | 1,349 | 5.7 |
| `GET /api/me/*` | 1,327 | 5.0 |
| `GET /api/projects/:id` | 1,327 | 4.8 |
| `GET /api/models` | 1,327 | 4.7 |
| `GET /api/chat/:threadId/messages` | 1,327 | 2.4 |
| `GET /api/admin/overview` | 12 | 119.5 |

