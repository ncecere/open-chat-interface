-- Full-text search over what was said in a conversation: the `text` parts of
-- user and assistant messages. Reasoning, sources, search grounding and
-- attachment metadata are deliberately left out of the document.
--
-- The expression must stay identical to `MESSAGE_SEARCH_VECTOR` in
-- apps/api/src/services/thread-search.ts, or the planner cannot use the index.
-- Every function in it is IMMUTABLE: the two-argument `to_tsvector(regconfig,
-- jsonb)` (indexes string values only, so JSON escaping such as `\n` never
-- leaks into lexemes) and `jsonb_path_query_array`. The 'simple' configuration
-- lowercases without stemming or stop words, so it behaves the same for every
-- language and prefix queries match the words as written.
--
-- Migrations run inside one transaction, so this cannot be CONCURRENTLY: on a
-- large message table the build takes time and blocks writes to `message`
-- until it finishes. See docs/OPERATIONS.md.
CREATE INDEX IF NOT EXISTS "message_text_search_idx" ON "message"
	USING gin (to_tsvector('simple'::regconfig, jsonb_path_query_array("parts", '$[*] ? (@.type == "text").text'::jsonpath)));
