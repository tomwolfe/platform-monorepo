-- Migration: Convert restaurant lat/lng from text to numeric for geospatial indexing
-- This enables proper index usage for location-based queries instead of full-table scans
-- The USING clause casts existing text values to numeric during the migration

ALTER TABLE restaurants
  ALTER COLUMN lat TYPE numeric(10, 7) USING lat::numeric(10, 7),
  ALTER COLUMN lng TYPE numeric(10, 7) USING lng::numeric(10, 7);

-- Add a GIST index for efficient geospatial queries (optional but recommended)
-- CREATE INDEX IF NOT EXISTS restaurants_location_idx ON restaurants USING gist (ll_to_earth(lat::double precision, lng::double precision));
-- For now, a simple btree index on lat/lng is sufficient for bounding box queries:
CREATE INDEX IF NOT EXISTS restaurants_lat_lng_idx ON restaurants (lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;
