# Scale harness results: `medium`, 2026-10-04

Commit `d31bfe1`; 1 API replica(s) behind the web proxy; stub model: first token after 500 ms, 50 tokens/s, 250 tokens a reply.

Hardware: Apple M4 Pro, 48 GiB memory, macOS 26.6; Docker: 12 CPUs, 7 GiB memory. Everything (PostgreSQL, Redis, API, web, stub, k6) shares that machine.

Load: sign-in storm at 40/s for 60 s (after a 30 s ramp), then 300 s of mixed load with 40 browsing, 20 chatting, 10 searching, 8 project-chatting, 2 admin and 1 job-running virtual users, each a signed-in person with think time.

## Dataset

| Table | Rows |
| --- | ---: |
| user | 6,000 |
| account | 6,000 |
| session | 3,313 |
| user_preference | 4,500 |
| project | 6,000 |
| thread | 400,000 |
| message | 4,000,000 |
| attachment | 100,687 |
| share_link | 8,819 |
| project_file_index | 36,805 |
| project_file_chunk | 437,363 |
| audit_log | 1,000,000 |
| usage_event | 1,000,000 |
| usage_record | 335,772 |
| project_file_embedding | 389,609 |
| storage_usage | 5,260 |
| quota_denial | 1,997 |

Generated in 447 s (COPY phase 54 s at 119,564 rows/s, 74,738 messages/s; 17,314 rows/s including derived tables, index rebuilds and VACUUM). Database after generation: 13.40 GiB. Embeddings: 1536 dimensions.

## Latency by scenario (ms)

| Scenario | p50 | p95 | p99 | n | Target (p95) | Met | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: |
| Sign-in storm (one sign-in) | 64 | 68 | 71 | 3,115 |  |  | 0.00% |
| Sidebar (parallel requests) | 9 | 68 | 531 | 4,303 | < 300 | yes | 0.00% |
| Sidebar: conversation list request | 7 | 51 | 499 | 4,303 |  |  | 0.00% |
| Open a conversation | 5 | 42 | 178 | 4,303 | < 300 | yes | 0.00% |
| Reply start added by OCI (chat) | 37 | 400 | 1,847 | 548 | < 1000 | yes | 0.00% |
|   … history under 20k characters | 36 | 458 | 1,841 | 487 |  |  | 0.00% |
|   … history 20k–150k characters | 40 | 194 | 1,016 | 61 |  |  | 0.00% |
| Reply start added by OCI (project chat) | 533 | 2,179 | 4,138 | 207 | < 1000 | **no** | 0.00% |
|   … large project: passages searched | 1,476 | 2,406 | 4,209 | 97 |  |  | 0.00% |
|   … small project: files included whole | 66 | 541 | 2,598 | 110 |  |  | 0.00% |
| Chat: time to first byte | 36 | 396 | 1,838 | 548 |  |  | 0.00% |
| Chat: whole reply (stub streams ~5 s) | 5,543 | 5,945 | 7,432 | 548 |  |  | 0.00% |
| Chat: relay after the last token | 17 | 101 | 302 | 548 |  |  | 0.00% |
| Project chat: whole reply | 6,024 | 7,673 | 9,636 | 207 |  |  | 0.00% |
| Keyword search (all terms) | 102 | 718 | 1,658 | 804 | < 1000 | yes | 0.00% |
| Keyword search: common word | 157 | 828 | 1,541 | 244 |  |  | 0.00% |
| Keyword search: medium word | 112 | 723 | 1,656 | 313 |  |  | 0.00% |
| Keyword search: rare word | 62 | 543 | 888 | 163 |  |  | 0.00% |
| Keyword search: two words | 58 | 232 | 549 | 84 |  |  | 0.00% |
| Admin pages (all) | 126 | 2,271 | 2,689 | 232 |  |  | 0.00% |
| Admin: overview | 1,828 | 2,804 | 3,024 | 29 |  |  | 0.00% |
| Admin: usage-overview | 1,601 | 2,591 | 2,693 | 29 |  |  | 0.00% |
| Admin: usage-spend | 1,176 | 1,550 | 1,657 | 29 |  |  | 0.00% |
| Admin: usage-limits | 7 | 13 | 20 | 29 |  |  | 0.00% |
| Admin: usage-storage | 87 | 102 | 205 | 29 |  |  | 0.00% |
| Admin: users | 12 | 30 | 37 | 29 |  |  | 0.00% |
| Admin: audit | 77 | 148 | 168 | 29 |  |  | 0.00% |
| Admin: health | 155 | 290 | 302 | 29 |  |  | 0.00% |

"Reply start added by OCI" is the time from sending the message to the stub model receiving the request: everything OCI does before the model is asked. The stub's own first-token delay is excluded; the relay of tokens back is measured separately ("relay after the last token").

## Background jobs under load

| Job | Runs | Items | p50 run (ms) | p95 run (ms) | Items per busy second | Items per minute |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| projects.index-files (files) | 36 | 1,800 | 487 | 1,773 | 74.3 | 360 |
| projects.embed-passages (passages) | 36 | 18,432 | 3,329 | 4,623 | 153.0 | 3686 |

## Retention under load

| Job | Duration (ms) | Rows deleted |
| --- | ---: | ---: |
| retention.usage-events | 968 | 150,090 |
| retention.audit-log | 527 | 125,767 |

While they ran: sidebar p95 14 ms, conversation opening p95 8 ms, errors 0.00%.

## Database

Size after the main run: 13.63 GiB.

| Table | Rows | Total | Table | Indexes | Dead tuples |
| --- | ---: | ---: | ---: | ---: | ---: |
| message | 4,003,771 | 6.94 GiB | 2.88 GiB | 1.81 GiB | 0.11% |
| project_file_embedding | 389,609 | 3.21 GiB | 61 MiB | 38 MiB | 0.00% |
| project_file_chunk | 437,350 | 1.87 GiB | 598 MiB | 216 MiB | 0.00% |
| audit_log | 999,911 | 482 MiB | 359 MiB | 123 MiB | 0.00% |
| attachment | 100,687 | 447 MiB | 55 MiB | 13 MiB | 0.04% |
| usage_event | 1,000,000 | 391 MiB | 224 MiB | 167 MiB | 0.01% |
| thread | 400,000 | 153 MiB | 85 MiB | 68 MiB | 0.23% |
| usage_record | 335,772 | 140 MiB | 69 MiB | 70 MiB | 0.02% |
| project_file_index | 36,805 | 6 MiB | 3 MiB | 3 MiB | 0.00% |
| share_link | 8,819 | 4 MiB | 2 MiB | 2 MiB | 0.00% |
| account | 6,000 | 3 MiB | 2 MiB | 1 MiB | 0.00% |
| session | 6,513 | 3 MiB | 2 MiB | 1 MiB | 0.00% |

| Largest indexes | Table | Size | Scans |
| --- | --- | ---: | ---: |
| message_text_search_idx | message | 1.06 GiB | 125 |
| message_pkey | message | 292 MiB | 79,639 |
| message_thread_position_idx | message | 259 MiB | 164,148 |
| project_file_chunk_search_idx | project_file_chunk | 173 MiB | 0 |
| message_parent_idx | message | 123 MiB | 0 |
| usage_event_pkey | usage_event | 73 MiB | 3,063 |
| audit_log_pkey | audit_log | 73 MiB | 0 |
| usage_event_user_occurred_idx | usage_event | 65 MiB | 913 |
| message_change_seq_idx | message | 65 MiB | 0 |
| project_file_chunk_pk | project_file_chunk | 43 MiB | 1,463,758 |

### Named queries (pg_stat_statements, main run)

| Query | Calls | Mean (ms) | Max (ms) |
| --- | ---: | ---: | ---: |
| Conversation search (message GIN index, filtered to one person) | 804 | 176.57 | 2,138 |
| Project keyword retrieval (ts_rank_cd over one project) | 126 | 981.97 | 2,051 |
| Project vector retrieval (pgvector exact scan over one project) | 126 | 63.54 | 383 |
| Embedding backlog (passages without an embedding) | 36 | 756.07 | 1,936 |
| Sidebar conversation list | 4,363 | 0.44 | 14 |
| Conversation messages | 9,778 | 0.52 | 100 |
| Usage reports (usage_event aggregates) | 1,694 | 46.18 | 2,719 |
| Message counts by time (admin overview) | 116 | 1373.25 | 2,904 |
| Quota admission (usage in the policy window) | 6,121 | 0.41 | 33 |
| Session lookup | 9 | 0.14 | 1 |

### pgvector exact scans (EXPLAIN ANALYZE after the main run)

| Scope | Passages scanned | Files | Median (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| Project with the most passages | 2,899 | 18 | 20.1 | 64.2 |
| Project with the #2 most passages | 2,743 | 18 | 18.4 | 38.9 |
| Project with the #3 most passages | 2,727 | 17 | 18.5 | 48.6 |
| Project with the #4 most passages | 2,714 | 19 | 18.1 | 58.0 |
| Project with the #5 most passages | 2,659 | 19 | 18.1 | 33.3 |
| Every embedding, no project filter (top 10) | 408,041 | | 1926.3 | |

### Top queries by total time (pg_stat_statements, main run)

| # | Calls | Total (ms) | Mean (ms) | Max (ms) | Query |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 804 | 141,966 | 176.6 | 2,138 | `with hits as materialized ( select m.id, m.thread_id, m.role, m.position, ts_rank(to_tsvector($17::regconfig, jsonb_path_query_array("m"."parts", $18::jsonpath)), $1::tsquery) as rank from message m join thread t on t.id` |
| 2 | 58 | 63,289 | 1091.2 | 2,719 | `select coalesce(sum("message_count"), $2)::bigint, coalesce(sum("tokens_in"::bigint + "tokens_out"::bigint), $3)::bigint, coalesce(sum("cost_micros"), $4)::bigint, count(distinct "user_id")::int from "usage_event" where ` |
| 3 | 44 | 52,302 | 1188.7 | 1,649 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 4 | 29 | 51,544 | 1777.4 | 2,904 | `select to_char(date_trunc($2, "created_at"), $3), count(*) from "message" where "message"."created_at" >= $1 group by date_trunc('day', "message"."created_at") order by date_trunc($4, "message"."created_at")` |
| 5 | 40 | 48,336 | 1208.4 | 2,051 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 6 | 29 | 45,543 | 1570.4 | 2,571 | `select to_char(date_trunc($3, occurred_at at time zone $1), $4) as day, sum(message_count) as messages, count(distinct user_id) as active_users from usage_event where occurred_at >= $2::timestamptz and pending = $5 group` |
| 7 | 29 | 44,282 | 1527.0 | 2,429 | `select count(*) from "message" where "message"."created_at" >= $1` |
| 8 | 29 | 41,493 | 1430.8 | 2,815 | `select count(*) from "message" where ("message"."created_at" >= $1 and "message"."created_at" < $2)` |
| 9 | 36 | 27,219 | 756.1 | 1,936 | `select c.attachment_id, a.user_id, a.organization_id, c.ordinal, c.content from project_file_chunk c join attachment a on a.id = c.attachment_id left join "project_file_embedding" e on e.attachment_id = c.attachment_id a` |
| 10 | 24 | 22,747 | 947.8 | 1,176 | `with scope as materialized ( select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search, a.filename from project_file_chunk c join attachment a on a.id = c.attachment_id where c.attachment_id = ` |
| 11 | 29 | 21,982 | 758.0 | 1,248 | `select count(*) filter (where role = $2) as sent, count(*) filter (where web_search_used = $3) as searched, count(*) filter (where status = $4) as errored, count(*) filter (where status = $5) as cancelled from message wh` |
| 12 | 29 | 21,978 | 757.8 | 1,145 | `select "model_slug", count(*)::int from "message" where ("message"."created_at" >= $1 and "message"."status" = $2 and "message"."model_slug" in ($3, $4, $5, $6, $7)) group by "message"."model_slug"` |

### Slowest API routes by total time (OCI metrics, all replicas)

| Route | Requests | Mean (ms) |
| --- | ---: | ---: |
| `POST /api/auth/*` | 3,200 | 91.6 |
| `POST /api/chat` | 757 | 318.6 |
| `GET /api/threads/:id` | 810 | 206.5 |
| `POST /api/admin/lifecycle/jobs/:name/run` | 72 | 2007.3 |
| `GET /api/threads` | 4,380 | 20.9 |
| `GET /api/projects/:id` | 4,209 | 21.6 |
| `GET /api/me/*` | 4,318 | 17.4 |
| `GET /api/models` | 4,318 | 16.8 |
| `GET /api/admin/overview` | 29 | 1940.0 |
| `GET /api/chat/:threadId/messages` | 4,318 | 11.6 |

