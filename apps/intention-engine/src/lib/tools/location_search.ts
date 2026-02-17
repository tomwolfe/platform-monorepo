import { z } from "zod";
import { redis } from "../redis-client";
import { env } from "../config";
import { RestaurantResultSchema } from "../schema";
import { GeocodeSchema, SearchRestaurantSchema, DB_REFLECTED_SCHEMAS, UnifiedLocationSchema } from "@repo/mcp-protocol";

/**
 * PhotonLocation - Standardized location response from Photon API
 */
export interface PhotonLocation {
  lat: number;
  lon: number;
  name?: string;
  street?: string;
  city?: string;
  postcode?: string;
  country?: string;
  state?: string;
  county?: string;
  suburb?: string;
  housenumber?: string;
  type?: string;
  osm_id?: number;
  osm_type?: string;
  extent?: [number, number, number, number];
}

/**
 * Geocode using Photon API (Komoot) - Primary geocoding service
 * Falls back to Nominatim if Photon fails
 */
export async function geocode_location_photon(params: z.infer<typeof GeocodeSchema>): Promise<{ success: boolean; result?: { lat: number; lon: number; displayName?: string }; error?: string }> {
  const validated = GeocodeSchema.safeParse(params);
  if (!validated.success) return { success: false, error: "Invalid parameters" };
  const { location, userLocation } = validated.data;

  // Vague location handling
  const vagueTerms = ["nearby", "near me", "around here", "here", "current location"];
  if (vagueTerms.includes(location.toLowerCase()) && userLocation) {
    console.log("Vague location detected, using userLocation bias.");
    return {
      success: true,
      result: {
        lat: userLocation.lat,
        lon: userLocation.lng
      }
    };
  }

  console.log(`[Photon] Geocoding location: ${location}...`);
  
  try {
    // Photon API with location bias
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=1`;

    if (userLocation) {
      // Bias results toward user location using lat/lon parameters
      url += `&lat=${userLocation.lat}&lon=${userLocation.lng}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'IntentionEngine/1.0'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Photon API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.features && data.features.length > 0) {
      const feature = data.features[0];
      const coords = feature.geometry.coordinates;
      const props = feature.properties;
      
      return {
        success: true,
        result: {
          lat: coords[1],
          lon: coords[0],
          displayName: props.name || props.street || props.city || location
        }
      };
    }

    // Fallback to Nominatim if Photon returns no results
    console.log(`[Photon] No results, falling back to Nominatim...`);
    return await geocode_location_nominatim(params);
    
  } catch (error: any) {
    console.warn(`[Photon] Geocoding failed: ${error.message}, falling back to Nominatim`);
    // Fallback to Nominatim on error
    return await geocode_location_nominatim(params);
  }
}

/**
 * Geocode using Nominatim (OpenStreetMap) - Fallback service
 */
export async function geocode_location_nominatim(params: z.infer<typeof GeocodeSchema>): Promise<{ success: boolean; result?: { lat: number; lon: number; displayName?: string }; error?: string }> {
  const validated = GeocodeSchema.safeParse(params);
  if (!validated.success) return { success: false, error: "Invalid parameters" };
  const { location, userLocation } = validated.data;

  // Vague location handling
  const vagueTerms = ["nearby", "near me", "around here", "here", "current location"];
  if (vagueTerms.includes(location.toLowerCase()) && userLocation) {
    console.log("Vague location detected, using userLocation bias.");
    return {
      success: true,
      result: {
        lat: userLocation.lat,
        lon: userLocation.lng
      }
    };
  }

  console.log(`[Nominatim] Geocoding location: ${location}...`);
  try {
    let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;

    if (userLocation) {
      const boxSize = 0.5;
      const viewbox = `${userLocation.lng - boxSize},${userLocation.lat + boxSize},${userLocation.lng + boxSize},${userLocation.lat - boxSize}`;
      url += `&viewbox=${viewbox}&bounded=0`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'IntentionEngine/1.0'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json();
    if (data && data.length > 0) {
      return {
        success: true,
        result: {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
          displayName: data[0].display_name
        }
      };
    }
    return { success: false, error: "Location not found" };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Primary geocode_location function - uses Photon first, then Nominatim
 */
export async function geocode_location(params: z.infer<typeof GeocodeSchema>) {
  return await geocode_location_photon(params);
}

export async function search_restaurant(params: z.infer<typeof SearchRestaurantSchema>) {
  const validated = SearchRestaurantSchema.safeParse(params);
  if (!validated.success) return { success: false, error: "Invalid parameters" };
  let { cuisine, lat, lon, location, userLocation } = validated.data;
  
  if ((lat === undefined || lon === undefined) && (location || userLocation)) {
    // If we have a location string, or just userLocation and no lat/lon
    const geo = await geocode_location({ 
      location: location || "nearby", 
      userLocation 
    });
    if (geo.success && geo.result) {
      lat = geo.result.lat;
      lon = geo.result.lon;
    } else if (!location && userLocation) {
        lat = userLocation.lat;
        lon = userLocation.lng;
    } else {
      return { success: false, error: "Could not geocode location and no coordinates provided." };
    }
  }

  if (lat === undefined || lon === undefined) {
    return { success: false, error: "Coordinates are required for restaurant search." };
  }

  // Cache key based on cuisine and rounded coordinates (approx 100m precision)
  const cacheKey = `restaurant:${cuisine || 'any'}:${lat.toFixed(3)}:${lon.toFixed(3)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Using cached results for ${cacheKey}`);
        return {
          success: true,
          result: cached
        };
      }
    } catch (err) {
      console.warn("Redis cache read failed:", err);
    }
  }

  console.log(`Searching for ${cuisine || 'restaurants'} near ${lat}, ${lon}...`);

  try {
    // 2. Overpass Query - STRICT cuisine filtering if provided
    const query = cuisine 
      ? `
        [out:json][timeout:10];
        nwr["amenity"="restaurant"]["cuisine"~"${cuisine}",i](around:10000,${lat},${lon});
        out center 10;
      `
      : `
        [out:json][timeout:10];
        nwr["amenity"="restaurant"](around:10000,${lat},${lon});
        out center 10;
      `;

    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const overpassRes = await fetch(overpassUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!overpassRes.ok) {
      throw new Error(`Overpass API error: ${overpassRes.statusText}`);
    }

    const overpassData = await overpassRes.json();
    let elements = overpassData.elements || [];

    // Mandatory strict-match filter for the cuisine parameter
    if (cuisine) {
      const regex = new RegExp(cuisine, 'i');
      elements = elements.filter((el: any) => {
        const elCuisine = el.tags?.cuisine || '';
        // Check if any of the cuisines match (cuisine tag can be a semi-colon separated list)
        return elCuisine.split(';').some((c: string) => regex.test(c.trim()));
      });
    }

    const results = elements.map((el: any) => {
      const name = el.tags.name || "Unknown Restaurant";
      const addr = [
        el.tags["addr:housenumber"],
        el.tags["addr:street"],
        el.tags["addr:city"]
      ].filter(Boolean).join(" ") || "Address not available";

      const elCuisine = el.tags?.cuisine 
        ? el.tags.cuisine.split(';').map((c: string) => c.trim())
        : [];

      const rawResult = {
        name,
        address: addr,
        cuisine: elCuisine,
        coordinates: {
          lat: parseFloat(el.lat || el.center?.lat),
          lon: parseFloat(el.lon || el.center?.lon)
        }
      };

      const validated = RestaurantResultSchema.safeParse(rawResult);
      return validated.success ? validated.data : null;
    }).filter(Boolean).slice(0, 5); // Limit to top 5

    if (redis && results.length > 0) {
      try {
        await redis.setex(cacheKey, 3600, results);
      } catch (err) {
        console.warn("Redis cache write failed:", err);
      }
    }

    return {
      success: true,
      result: results
    };
  } catch (error: any) {
    console.error("Error in search_restaurant:", error);
    return { success: false, error: error.message };
  }
}

export async function search_web(query: string): Promise<{ success: boolean; result?: any; error?: string }> {
  console.log(`Searching web for: ${query}...`);
  try {
    // Using DuckDuckGo's free "Instant Answer" API as a fallback for discovery
    const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
    const data = await response.json();
    
    // Simple heuristic for demo: extract email if found in abstract or related topics
    // In a real production app, we would use a more robust search + scraping or a professional API
    const abstract = data.AbstractText || "";
    const emailMatch = abstract.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    return {
      success: true,
      result: {
        text: abstract,
        email: emailMatch ? emailMatch[0] : null,
        source: "DuckDuckGo"
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
