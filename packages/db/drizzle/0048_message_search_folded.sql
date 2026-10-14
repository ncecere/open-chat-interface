-- Accent-insensitive search of message text (#362, SPEC-accent-search.md).
--
-- `message.search_folded` is the search vector of a message's text parts with
-- accents folded (oci_fold_search_text, migration 0047), kept by a trigger so
-- that every writer is covered: this release, the previous one during a rolling
-- upgrade, and any path that updates `parts`. It is NULL when folding leaves
-- the text unchanged (plain English, other scripts), because the exact index
-- already finds those words; search matches the exact index OR this one, so a
-- message is found by what is typed whichever way it is spelled.
--
-- The vector is built exactly as `message_text_search_idx` builds its own
-- (text parts only, `simple` configuration), over the folded JSON text: the
-- fold changes letters, never JSON syntax, so `to_tsvector` still reads string
-- values only.
--
-- Additive and pre-deploy safe: a nullable column without a default is no
-- rewrite, and the trigger is cheap (about a millisecond per message written,
-- none when `parts` is unchanged). The previous release never reads it. Rows
-- written before this migration are filled by the background migration
-- `0.13.message-search-folded`, and its index is built by post-deploy step
-- 0014_message_search_folded_index; search uses neither until both are done.
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "search_folded" tsvector;
--> statement-breakpoint
-- The one definition of the vector: the trigger and the background migration
-- both call it. NULL means folding leaves the text unchanged.
CREATE OR REPLACE FUNCTION "oci_message_folded_vector"(parts jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
	SELECT CASE WHEN oci_fold_search_text(document) = document THEN NULL
		ELSE to_tsvector('simple'::regconfig, oci_fold_search_text(document)::jsonb) END
	FROM (SELECT jsonb_path_query_array(parts, '$[*] ? (@.type == "text").text'::jsonpath)::text AS document) AS d
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "message_set_search_folded"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW."parts" IS NOT DISTINCT FROM OLD."parts" THEN
		RETURN NEW;
	END IF;
	NEW."search_folded" := oci_message_folded_vector(NEW."parts");
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "message_search_folded" ON "message";
--> statement-breakpoint
CREATE TRIGGER "message_search_folded" BEFORE INSERT OR UPDATE OF "parts" ON "message"
	FOR EACH ROW EXECUTE FUNCTION "message_set_search_folded"();
