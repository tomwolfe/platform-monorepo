import { z } from "zod";
import {
  getRedisClient,
  ServiceNamespace,
  Logger,
  AppConfig,
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);
import { env } from "../config";
import { RestaurantResultSchema } from "../schema";
import {
  GeocodeSchema,
  SearchRestaurantSchema,
  DB_REFLECTED_SCHEMAS,
  UnifiedLocationSchema,
} from "@repo/mcp-protocol";
import {
  withNervousSystemTracing,
  injectTracingHeaders,
} from "@repo/shared/tracing";

const logger = new Logger({ serviceName: "location-search" });

/**
 * Circuit breakers for external geocoding and search providers
 */
const photonBreaker = new CircuitBreaker("photon-geocoding", {
  failureThreshold: 3,
  resetTimeoutMs: 30000,
  successThreshold: 2,
  requestTimeoutMs: 8000,
});

const nominatimBreaker = new CircuitBreaker("nominatim-geocoding", {
  failureThreshold: 3,
  resetTimeoutMs: 30000,
  successThreshold: 2,
  requestTimeoutMs: 8000,
});

const overpassBreaker = new CircuitBreaker("overpass-api", {
  failureThreshold: 3,
  resetTimeoutMs: 60000,
  successThreshold: 2,
  requestTimeoutMs: 5000,
});

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
export async function geocode_location_photon(
  params: z.infer<typeof GeocodeSchema>,
): Promise<{
  success: boolean;
  result?: { lat: number; lon: number; displayName?: string };
  error?: string;
}> {
  const validated = GeocodeSchema.safeParse(params);
  if (!validated.success)
    return { success: false, error: "Invalid parameters" };
  const { location, userLocation } = validated.data;

  // Vague location handling
  const vagueTerms = [
    "nearby",
    "near me",
    "around here",
    "here",
    "current location",
  ];
  if (vagueTerms.includes(location.toLowerCase()) && userLocation) {
    logger.info({
      message: "Vague location detected, using userLocation bias",
    });
    return {
      success: true,
      result: {
        lat: userLocation.lat,
        lon: userLocation.lng,
      },
    };
  }

  logger.info({ message: "Geocoding location via Photon", location });

  try {
    // Photon API with location bias
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=1`;

    if (userLocation) {
      // Bias results toward user location using lat/lon parameters
      url += `&lat=${userLocation.lat}&lon=${userLocation.lng}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    return await withNervousSystemTracing(async ({ correlationId }) => {
      const response = await photonBreaker.execute(async () => {
        return await fetch(url, {
          headers: {
            "User-Agent": "IntentionEngine/1.0",
            ...injectTracingHeaders({}, correlationId),
          },
          signal: controller.signal,
        });
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
            displayName: props.name || props.street || props.city || location,
          },
        };
      }

      // Fallback to Nominatim if Photon returns no results
      logger.info({
        message: "Photon returned no results, falling back to Nominatim",
      });
      return await geocode_location_nominatim(params);
    });
  } catch (error: unknown) {
    if (error instanceof CircuitBreakerOpenError) {
      logger.warn({
        message: "Photon circuit breaker open, falling back to Nominatim",
      });
    } else {
      logger.warn({
        message: "Photon geocoding failed, falling back to Nominatim",
        error: (error as Error).message,
      });
    }
    // Fallback to Nominatim on error
    return await geocode_location_nominatim(params);
  }
}

/**
 * Geocode using Nominatim (OpenStreetMap) - Fallback service
 */
export async function geocode_location_nominatim(
  params: z.infer<typeof GeocodeSchema>,
): Promise<{
  success: boolean;
  result?: { lat: number; lon: number; displayName?: string };
  error?: string;
}> {
  const validated = GeocodeSchema.safeParse(params);
  if (!validated.success)
    return { success: false, error: "Invalid parameters" };
  const { location, userLocation } = validated.data;

  // Vague location handling
  const vagueTerms = [
    "nearby",
    "near me",
    "around here",
    "here",
    "current location",
  ];
  if (vagueTerms.includes(location.toLowerCase()) && userLocation) {
    logger.info({
      message: "Vague location detected, using userLocation bias",
    });
    return {
      success: true,
      result: {
        lat: userLocation.lat,
        lon: userLocation.lng,
      },
    };
  }

  logger.info({ message: "Geocoding location via Nominatim", location });
  try {
    let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;

    if (userLocation) {
      const boxSize = 0.5;
      const viewbox = `${userLocation.lng - boxSize},${userLocation.lat + boxSize},${userLocation.lng + boxSize},${userLocation.lat - boxSize}`;
      url += `&viewbox=${viewbox}&bounded=0`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    return await withNervousSystemTracing(async ({ correlationId }) => {
      const response = await nominatimBreaker.execute(async () => {
        return await fetch(url, {
          headers: {
            "User-Agent": "IntentionEngine/1.0",
            ...injectTracingHeaders({}, correlationId),
          },
          signal: controller.signal,
        });
      });

      clearTimeout(timeoutId);

      const data = await response.json();
      if (data && data.length > 0) {
        return {
          success: true,
          result: {
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
            displayName: data[0].display_name,
          },
        };
      }
      return { success: false, error: "Location not found" };
    });
  } catch (error: unknown) {
    return { success: false, error: error.message };
  }
}

/**
 * Primary geocode_location function - uses Photon first, then Nominatim
 */
export async function geocode_location(params: z.infer<typeof GeocodeSchema>) {
  return await geocode_location_photon(params);
}

export async function search_restaurant(
  params: z.infer<typeof SearchRestaurantSchema>,
) {
  const validated = SearchRestaurantSchema.safeParse(params);
  if (!validated.success)
    return { success: false, error: "Invalid parameters" };
  let { cuisine, lat, lon, location, userLocation } = validated.data;

  if ((lat === undefined || lon === undefined) && (location || userLocation)) {
    const geo = await geocode_location({
      location: location || "nearby",
      userLocation,
    });
    if (geo.success && geo.result) {
      lat = geo.result.lat;
      lon = geo.result.lon;
    } else if (!location && userLocation) {
      lat = userLocation.lat;
      lon = userLocation.lng;
    } else {
      return {
        success: false,
        error: "Could not geocode location and no coordinates provided.",
      };
    }
  }

  if (lat === undefined || lon === undefined) {
    return {
      success: false,
      error: "Coordinates are required for restaurant search.",
    };
  }

  // Cache key based on cuisine and rounded coordinates (approx 100m precision)
  const cacheKey = `restaurant:${cuisine || "any"}:${lat.toFixed(3)}:${lon.toFixed(3)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info({
          message: "Using cached restaurant search results",
          cacheKey,
        });
        return {
          success: true,
          result: cached,
        };
      }
    } catch (err) {
      logger.warn({ message: "Redis cache read failed", error: String(err) });
    }
  }

  logger.info({
    message: "Searching for restaurants",
    cuisine: cuisine || "any",
    lat,
    lon,
  });

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

    return await withNervousSystemTracing(async ({ correlationId }) => {
      let overpassRes: Response;

      try {
        overpassRes = await overpassBreaker.execute(async () => {
          return await fetch(overpassUrl, {
            headers: injectTracingHeaders({}, correlationId),
            signal: controller.signal,
          });
        });
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId);

        // Handle circuit breaker open
        if (fetchError instanceof CircuitBreakerOpenError) {
          logger.warn({
            message:
              "Overpass API circuit breaker open, returning graceful fallback",
          });
          return {
            success: true,
            result: [],
            warning:
              "Restaurant search is temporarily unavailable. Please try again later.",
          };
        }

        // Handle AbortError (timeout) or network errors
        if (
          (fetchError instanceof Error && fetchError.name === "AbortError") ||
          (fetchError instanceof Error && fetchError.message?.includes("fetch"))
        ) {
          logger.warn({
            message:
              "Overpass API timeout or network error, returning graceful fallback",
          });
          return {
            success: true,
            result: [],
            warning:
              "Restaurant search temporarily unavailable. Please try again later.",
          };
        }

        throw fetchError;
      }

      clearTimeout(timeoutId);

      // Handle HTTP error status codes
      if (!overpassRes.ok) {
        const statusCode = overpassRes.status;

        // Handle rate limiting (429) or service unavailable (503)
        if (statusCode === 429) {
          logger.warn({
            message:
              "Overpass API rate limited (429), returning graceful fallback",
            statusCode,
          });
          return {
            success: true,
            result: [],
            warning:
              "Restaurant search is currently rate-limited. Please try again in a moment.",
          };
        }

        if (statusCode === 503 || statusCode >= 500) {
          logger.warn({
            message: "Overpass API unavailable, returning graceful fallback",
            statusCode,
          });
          return {
            success: true,
            result: [],
            warning:
              "Restaurant search is temporarily unavailable. Please try again later.",
          };
        }

        throw new Error(`Overpass API error: ${overpassRes.statusText}`);
      }

      const overpassData = await overpassRes.json();
      let elements = overpassData.elements || [];

      // Mandatory strict-match filter for the cuisine parameter
      if (cuisine) {
        const regex = new RegExp(cuisine, "i");
        elements = elements.filter((el: any) => {
          const elCuisine = el.tags?.cuisine || "";
          // Check if any of the cuisines match (cuisine tag can be a semi-colon separated list)
          return elCuisine.split(";").some((c: string) => regex.test(c.trim()));
        });
      }

      const results = elements
        .map((el: any) => {
          const name = el.tags.name || "Unknown Restaurant";
          const addr =
            [
              el.tags["addr:housenumber"],
              el.tags["addr:street"],
              el.tags["addr:city"],
            ]
              .filter(Boolean)
              .join(" ") || "Address not available";

          const elCuisine = el.tags?.cuisine
            ? el.tags.cuisine.split(";").map((c: string) => c.trim())
            : [];

          const rawResult = {
            name,
            address: addr,
            cuisine: elCuisine,
            coordinates: {
              lat: parseFloat(el.lat || el.center?.lat),
              lon: parseFloat(el.lon || el.center?.lon),
            },
          };

          const validated = RestaurantResultSchema.safeParse(rawResult);
          return validated.success ? validated.data : null;
        })
        .filter(Boolean)
        .slice(0, 5); // Limit to top 5

      if (redis && results.length > 0) {
        try {
          await redis.setex(cacheKey, 3600, results);
        } catch (err) {
          logger.warn({
            message: "Redis cache write failed",
            error: String(err),
          });
        }
      }

      return {
        success: true,
        result: results,
      };
    });
  } catch (error: unknown) {
    logger.error({
      message: "Error in search_restaurant",
      error: error instanceof Error ? error.message : String(error),
    });
    // Graceful fallback for any unhandled errors
    return {
      success: true,
      result: [],
      warning:
        "Restaurant search encountered an error. Please try again later.",
    };
  }
}

export async function search_web(
  query: string,
): Promise<{ success: boolean; result?: any; error?: string }> {
  logger.info({ message: "Searching web", query });

  try {
    return await withNervousSystemTracing(async ({ correlationId }) => {
      // PRODUCTION IMPLEMENTATION: Use Tavily API if available (reliable, rate-limit friendly)
      const tavilyApiKey =
        process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY;

      if (tavilyApiKey && process.env.TAVILY_API_KEY) {
        try {
          // Tavily Search API - production-grade search
          const tavilyController = new AbortController();
          const tavilyTimeoutId = setTimeout(
            () => tavilyController.abort(),
            5000,
          );

          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...injectTracingHeaders({}, correlationId),
            },
            body: JSON.stringify({
              api_key: tavilyApiKey,
              query,
              search_depth: "basic",
              max_results: 3,
            }),
            signal: tavilyController.signal,
          });

          clearTimeout(tavilyTimeoutId);

          if (response.ok) {
            const data = await response.json();
            const results = data.results || [];

            // Extract email from results if found
            const emailMatch = results
              .map((r: any) => r.content || "")
              .join(" ")
              .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

            return {
              success: true,
              result: {
                text: results[0]?.content || "",
                email: emailMatch ? emailMatch[0] : null,
                source: "Tavily",
                results: results.slice(0, 3),
              },
            };
          }
        } catch (error: unknown) {
          logger.warn({
            message: "Tavily API failed, falling back to mock",
            error: (error as Error).message,
          });
        }
      }

      // FALLBACK: Production guardrail - NEVER generate fake contact information in production
      // SECURITY: In production, return failure so the Intention Engine can gracefully replan
      if (AppConfig.isProduction()) {
        logger.error({
          message:
            "Tavily API unavailable in production - returning failure (no fake contact data generation)",
        });
        return {
          success: false,
          error: "Search service unavailable. Please try again later.",
        };
      }

      // Development/test mode only: deterministic mock for offline/rate-limited scenarios
      logger.info({
        message:
          "Using deterministic mock (dev/test mode - no API key or API unavailable)",
      });

      // Extract potential restaurant/business name from query
      const queryLower = query.toLowerCase();
      const match = queryLower.match(
        /(?:at|from|for|about)\s+([a-z][a-z0-9\s&]{2,30})/i,
      );
      const businessName = match
        ? match[1].trim()
        : queryLower.split(" ").slice(0, 3).join(" ");

      // Generate deterministic email
      const slug = businessName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 30);

      const email = `contact@${slug}.com`;

      return {
        success: true,
        result: {
          text: `Contact information for ${businessName || "the requested business"}. Email: ${email}`,
          email,
          source: "Mock (offline mode)",
          note: "This is a fallback response. Configure TAVILY_API_KEY for real search results.",
        },
      };
    });
  } catch (error: unknown) {
    // Graceful fallback on any error
    logger.error({ message: "Search failed", error: (error as Error).message });

    return {
      success: true,
      result: {
        text: "Search temporarily unavailable. Please try again later.",
        email: null,
        source: "Fallback",
        warning: "Search service encountered an error.",
      },
    };
  }
}
