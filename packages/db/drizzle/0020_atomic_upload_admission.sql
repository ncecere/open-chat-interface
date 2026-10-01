ALTER TABLE "attachment" ADD COLUMN "upload_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Legacy unfinished uploads were not safe to expose either. Drain old producers
-- before upgrading; these reservations require explicit recovery, not TTL reuse.
UPDATE "attachment" SET "upload_pending" = true WHERE "storage_key" = 'pending';
--> statement-breakpoint
-- Every hard-delete path, including FK cascades, releases counted capacity.
-- UPDATE (not UPSERT) also permits deletion of the owning account itself.
CREATE FUNCTION oci_release_deleted_attachment_usage() RETURNS trigger AS $$
BEGIN
  UPDATE storage_usage SET
    live_bytes = greatest(0, live_bytes - CASE WHEN OLD.deleted_at IS NULL THEN OLD.size_bytes ELSE 0 END),
    live_file_count = greatest(0, live_file_count - CASE WHEN OLD.deleted_at IS NULL THEN 1 ELSE 0 END),
    pending_bytes = greatest(0, pending_bytes - CASE WHEN OLD.deleted_at IS NOT NULL THEN OLD.size_bytes ELSE 0 END),
    pending_file_count = greatest(0, pending_file_count - CASE WHEN OLD.deleted_at IS NOT NULL THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE user_id = OLD.user_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER attachment_release_storage_usage
AFTER DELETE ON attachment FOR EACH ROW EXECUTE FUNCTION oci_release_deleted_attachment_usage();
