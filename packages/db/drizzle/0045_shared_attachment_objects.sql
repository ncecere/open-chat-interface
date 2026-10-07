-- A stored file may be used by several attachment rows (#358). A fork, and an
-- edit that keeps its question's file, no longer share one attachment id with
-- the conversation they were made from: each gets a row of its own for the
-- file, so each conversation owns, counts, trashes and deletes its copy. The
-- rows point at the same stored object (`storage_key`, and `thumbnail_key`),
-- which must be deleted only when the last row using it goes.
--
-- The delete trigger (0011) queued the object whenever a row went. It now asks
-- whether another row still uses the object, and if one does it queues it
-- parked (`next_attempt_at = 'infinity'`): the reaper before this release
-- takes only entries that are due, so it never deletes a parked object, and
-- the reaper of this release re-checks a parked entry once it runs, deleting
-- the object when nothing uses it any more and dropping the entry when
-- something still does (the row that is deleted last queues its own). This
-- keeps an upgrade safe whichever release's reaper runs while the other
-- serves, and two rows deleted at the same moment (each seeing the other still
-- there) cannot leave an object that nothing queued.
--
-- Pre-deploy safe: the previous release neither reads nor writes anything new.
-- It inserts and deletes attachment rows as before, and the function is
-- replaced inside this transaction, so no delete sees a half-changed
-- trigger. The lookups use `attachment_storage_key_idx` and
-- `attachment_thumbnail_key_idx`, built CONCURRENTLY by post-deploy steps 0011
-- and 0012 (an index on an existing table cannot be built here without
-- blocking writes); until they have run, deleting a file or a conversation
-- scans the attachment table once per file, which is slower on a large
-- instance and correct.
--
-- Re-runnable: `CREATE OR REPLACE`.
CREATE OR REPLACE FUNCTION oci_enqueue_deleted_attachment_object()
RETURNS TRIGGER AS $$
BEGIN
	IF OLD."storage_key" IS NOT NULL AND OLD."storage_key" <> 'pending' THEN
		INSERT INTO "deleted_object" ("storage_key", "size_bytes", "user_id", "next_attempt_at")
		VALUES (
			OLD."storage_key",
			COALESCE(OLD."size_bytes", 0),
			OLD."user_id",
			CASE WHEN EXISTS (SELECT 1 FROM "attachment" WHERE "storage_key" = OLD."storage_key")
				THEN 'infinity'::timestamptz ELSE now() END
		);
	END IF;

	IF OLD."thumbnail_key" IS NOT NULL THEN
		INSERT INTO "deleted_object" ("storage_key", "size_bytes", "user_id", "next_attempt_at")
		VALUES (
			OLD."thumbnail_key",
			0,
			OLD."user_id",
			CASE WHEN EXISTS (SELECT 1 FROM "attachment" WHERE "thumbnail_key" = OLD."thumbnail_key")
				THEN 'infinity'::timestamptz ELSE now() END
		);
	END IF;

	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
