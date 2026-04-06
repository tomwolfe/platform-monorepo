-- Custom migration: Add GPS location columns to drivers table for proximity-based matching

-- Add GPS location columns for real-time driver tracking
ALTER TABLE "drivers" ADD COLUMN "current_lat" numeric(10, 7);
ALTER TABLE "drivers" ADD COLUMN "current_lng" numeric(10, 7);

-- Create indexes for geospatial queries (bounding box searches)
CREATE INDEX "drivers_location_idx" ON "drivers" ("current_lat", "current_lng");
CREATE INDEX "drivers_active_location_idx" ON "drivers" ("is_active", "current_lat", "current_lng");
