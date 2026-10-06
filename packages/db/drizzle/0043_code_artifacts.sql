-- Code artifacts (#298). Asked for "a Code artifact" holding a Python script,
-- a model could only choose HTML, SVG, Mermaid or Markdown, so it wrapped the
-- script in an HTML page: the preview read `<inventory.csv>` as a tag and
-- dropped it, and Download gave an `.html` file. An artifact may now be
-- `code`, with its `language` (`python`, `bash`, ...), shown as code and
-- downloaded with that language's extension.
--
-- Pre-deploy safe: the previous release writes only the four older kinds and
-- never reads `language`, so it works unchanged on this schema. It cannot
-- draw a code artifact's card, so none is made until every replica and web
-- proxy runs this release: post-deploy step 0009 is the signal.
-- * The new column is nullable, without a default: a catalog change only.
-- * The kind check is replaced by a wider one, and the language check added,
--   both NOT VALID, so no statement scans the table. A NOT VALID check is
--   still enforced for every new or changed row. Every existing row already
--   satisfies both (an older kind, and no language); post-deploy step 0009
--   validates the kind check.
--
-- Re-runnable: every statement is guarded.
ALTER TABLE "artifact" ADD COLUMN IF NOT EXISTS "language" text;--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT IF EXISTS "artifact_kind";--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_kind" CHECK ("artifact"."kind" in ('html', 'svg', 'mermaid', 'markdown', 'code')) NOT VALID;--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT IF EXISTS "artifact_language_length";--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_language_length" CHECK (char_length("artifact"."language") between 1 and 32) NOT VALID;
