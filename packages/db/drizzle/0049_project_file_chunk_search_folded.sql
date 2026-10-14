-- Accent-insensitive keyword search of project files (#362, SPEC-accent-search.md).
--
-- `project_file_chunk.search_folded` is the search vector of a chunk's text
-- with accents folded (oci_fold_search_text, migration 0047), kept by a trigger
-- so every writer is covered, the previous release during a rolling upgrade
-- included. NULL when folding leaves the text unchanged: those chunks are
-- found through `search` (the generated exact vector) as they always were, and
-- search reads coalesce(search_folded, search).
--
-- No index: keyword search runs over one project's chunks, materialized first
-- (retrieval.ts, "scope"), and never used the GIN index on `search` either.
--
-- Additive and pre-deploy safe: a nullable column without a default is no
-- rewrite. The previous release never reads it. Chunks written before this
-- migration are filled by the background migration `0.13.chunk-search-folded`;
-- search reads the column only once that is done.
ALTER TABLE "project_file_chunk" ADD COLUMN IF NOT EXISTS "search_folded" tsvector;
--> statement-breakpoint
-- The one definition of the vector: the trigger and the background migration
-- both call it. NULL means folding leaves the text unchanged.
CREATE OR REPLACE FUNCTION "oci_chunk_folded_vector"(content text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
	SELECT CASE WHEN oci_fold_search_text(content) = content THEN NULL
		ELSE to_tsvector('simple'::regconfig, oci_fold_search_text(content)) END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "project_file_chunk_set_search_folded"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW."content" IS NOT DISTINCT FROM OLD."content" THEN
		RETURN NEW;
	END IF;
	NEW."search_folded" := oci_chunk_folded_vector(NEW."content");
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_file_chunk_search_folded" ON "project_file_chunk";
--> statement-breakpoint
CREATE TRIGGER "project_file_chunk_search_folded" BEFORE INSERT OR UPDATE OF "content" ON "project_file_chunk"
	FOR EACH ROW EXECUTE FUNCTION "project_file_chunk_set_search_folded"();
