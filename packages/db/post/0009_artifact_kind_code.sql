-- Code artifacts (#298, pre-deploy migration 0043). 0043 widened the kind
-- check to allow `code` NOT VALID, so `migrate` scanned nothing; this checks
-- the existing rows (VALIDATE takes a SHARE UPDATE EXCLUSIVE lock: reads and
-- writes go on) and is idempotent.
--
-- It also gates the feature: the API makes code artifacts only once this step
-- has finished (apps/api/src/services/artifacts/code-kind.ts), since it runs
-- after every replica and web proxy runs this release. The previous release's
-- web app cannot draw a code artifact's card.
ALTER TABLE "artifact" VALIDATE CONSTRAINT "artifact_kind";
