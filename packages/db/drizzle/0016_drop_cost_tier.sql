-- Cost tier was only ever decorative: it rendered a "$$" badge and fed no
-- pricing, quota, or routing decision. With the field removed from the model
-- form it became a value nobody could edit, so the column goes too.
ALTER TABLE "model" DROP COLUMN IF EXISTS "cost_tier";
