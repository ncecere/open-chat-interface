-- As 0011, for the thumbnail of an attachment (#358): partial, because most
-- rows have none.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attachment_thumbnail_key_idx" ON "attachment" ("thumbnail_key") WHERE "thumbnail_key" IS NOT NULL;
