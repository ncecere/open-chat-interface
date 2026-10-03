-- Backups include files (v0.10). See docs/dev/v0.10-design-backups.md and
-- docs/admin/backups.md, "Attachment files".
--
-- A backup can now copy attachment objects to the destination, content
-- addressed by SHA-256 under `<prefix>objects/`, copying only objects not
-- already there. These columns record what a run copied, what it found
-- already present, how many stored objects it read back and checksummed, and
-- how many unreferenced objects the sweep after retention deleted. All are
-- NULL for a run that did not copy files (existing runs, and runs with
-- copying off), which is also how the sweep tells which manifests reference
-- `objects/`.
--
-- Re-runnable: every statement is guarded, so applying it twice is harmless.
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "copied_objects" integer;
--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "copied_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "skipped_objects" integer;
--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "skipped_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "verified_objects" integer;
--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "swept_objects" integer;
