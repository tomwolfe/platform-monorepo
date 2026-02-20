-- Fix for Rhinelander restaurant visibility issue
-- Run this in your Neon/PostgreSQL console to make existing restaurants visible

-- Step 1: Update is_claimed and is_shadow flags for all existing restaurants
-- This ensures restaurants created before the fix are now visible
UPDATE restaurants 
SET is_claimed = true, is_shadow = false 
WHERE is_claimed = false OR is_claimed IS NULL;

-- Step 2: Verify the update
SELECT id, name, slug, is_claimed, is_shadow, lat, lng 
FROM restaurants 
WHERE slug LIKE '%rhinelander%' OR slug LIKE '%pesto%';

-- Step 3: If Rhinelander has NULL or empty coordinates, manually fix them
-- Replace 'your-rhinelander-slug' with the actual slug value from Step 2
-- Coordinates for Rhinelander, WI area (approximate)
UPDATE restaurants 
SET lat = '45.6300', lng = '-89.4100' 
WHERE slug = 'your-rhinelander-slug' 
  AND (lat IS NULL OR lat = '' OR lng IS NULL OR lng = '');

-- Step 4: Verify final state
SELECT 
  name, 
  slug, 
  is_claimed, 
  is_shadow,
  lat, 
  lng,
  CASE 
    WHEN lat IS NULL OR lat = '' OR lng IS NULL OR lng = '' THEN 'MISSING COORDINATES'
    ELSE 'OK'
  END as coordinate_status
FROM restaurants
ORDER BY created_at DESC
LIMIT 20;
