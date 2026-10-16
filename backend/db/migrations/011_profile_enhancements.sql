-- CampusHub — Profile system enhancements.
-- Adds cover image, department, year, and privacy settings to users.
-- Run AFTER 010. Idempotent: re-running is a no-op.

BEGIN;

-- Cover / wallpaper image URL for user profile header
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- Academic info for students
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS year TEXT;

-- Privacy controls: controls what is visible on public profile
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_settings JSONB
  NOT NULL DEFAULT '{"showEmail":false,"showPhone":false,"showActivity":true}';

COMMIT;
