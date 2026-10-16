-- CampusHub — Public seller/merchant profile fields for `stores`.
--
-- The public seller page (/seller/:id) presents a storefront with a cover
-- banner, a display category, and optional public contact details. None of
-- these are needed to run the marketplace, so they are all NULLABLE and only
-- surfaced by the public endpoint; existing store rows are unaffected.
--
--   * cover_image_url  -> wide banner image for the profile header
--   * category         -> free-text storefront category (e.g. "Electronics");
--                         distinct from products.category_id, which is a FK.
--   * public_email     -> optional contact email the seller chooses to publish
--   * public_phone     -> optional contact phone the seller chooses to publish
--
-- Idempotent: safe to re-run. Run it AFTER 001-009.

BEGIN;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS category        TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS public_email    TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS public_phone    TEXT;

COMMIT;
