-- Migration: Add exclusion constraint to prevent double-booking
-- This provides database-level protection against overlapping reservations
-- Date: 2026-04-06

-- IMPORTANT: This migration requires the btree_gist extension
-- This extension is included in most Postgres installations (including Neon)
-- If not available, run: CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Add exclusion constraint to prevent overlapping time slots for the same table
-- This ensures that no two confirmed reservations can book the same table at overlapping times
ALTER TABLE restaurant_reservations
ADD CONSTRAINT no_overlapping_table_reservations
EXCLUDE USING gist (
  table_id WITH =,
  tstzrange(start_time, end_time) WITH &&
)
WHERE (status = 'confirmed' AND table_id IS NOT NULL);

-- Note: This constraint works alongside the application-layer checks in reserve_api.ts
-- The application layer uses FOR UPDATE SKIP LOCKED for performance
-- This constraint provides a safety net to prevent race conditions at the DB level

-- For combined table reservations (multiple tables booked together),
-- the application-layer logic handles the complexity since exclusion constraints
-- work on a per-row basis. The enhanced conflict detection in reserve_api.ts
-- checks for overlaps with both single table and combined table reservations.

COMMENT ON CONSTRAINT no_overlapping_table_reservations ON restaurant_reservations IS 
  'Prevents double-booking: No two confirmed reservations can overlap in time for the same table';
