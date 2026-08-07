WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "organization_id", "role"
    ORDER BY "updated_at" DESC, "id" DESC
  ) AS "row_number"
  FROM "role_quota"
)
DELETE FROM "role_quota"
WHERE "id" IN (SELECT "id" FROM ranked WHERE "row_number" > 1);--> statement-breakpoint
DROP INDEX "role_quota_org_role_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "role_quota_org_role_unique" ON "role_quota" USING btree ("organization_id","role");