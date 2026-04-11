/**
 * Shared geocoding utility for the monorepo
 * Uses Photon API (Komoot) as primary service with Nominatim fallback
 */

import { Logger } from "../logger";

const logger = new Logger({ serviceName: "geo" });

export interface GeocodeResult {
  success: boolean;
  result?: {
    lat: number;
    lng: number;
    displayName?: string;
    address?: {
      street?: string;
      city?: string;
      postcode?: string;
      country?: string;
      state?: string;
    };
  };
  error?: string;
}

export interface UserLocation {
  lat: number;
  lng: number;
}

/**
 * Geocode an address using Photon API (Komoot)
 * @param address - The address to geocode
 * @param userLocation - Optional user location to bias results
 * @returns GeocodeResult with coordinates
 */
export async function geocode(
  address: string,
  userLocation?: UserLocation,
): Promise<GeocodeResult> {
  // Handle vague location terms
  const vagueTerms = [
    "nearby",
    "near me",
    "around here",
    "here",
    "current location",
  ];
  if (vagueTerms.includes(address.toLowerCase()) && userLocation) {
    return {
      success: true,
      result: {
        lat: userLocation.lat,
        lng: userLocation.lng,
      },
    };
  }

  try {
    // Photon API with optional location bias
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1`;

    if (userLocation) {
      url += `&lat=${userLocation.lat}&lon=${userLocation.lng}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "TableStack-OpenDeliver/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Photon API error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.features && data.features.length > 0) {
      const feature = data.features[0];
      const coords = feature.geometry.coordinates; // [lng, lat]
      const props = feature.properties;

      return {
        success: true,
        result: {
          lat: coords[1],
          lng: coords[0],
          displayName: props.name || props.street || props.city || address,
          address: {
            street: props.street,
            city: props.city,
            postcode: props.postcode,
            country: props.country,
            state: props.state,
          },
        },
      };
    }

    // Fallback to Nominatim if Photon returns no results
    logger.warn({ message: "No Photon results, falling back to Nominatim" });
    return await geocodeNominatim(address, userLocation);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({
      message: "Photon geocoding failed, falling back to Nominatim",
      errorMessage,
    });
    return await geocodeNominatim(address, userLocation);
  }
}

/**
 * Geocode using Nominatim (OpenStreetMap) - Fallback service
 */
async function geocodeNominatim(
  address: string,
  userLocation?: UserLocation,
): Promise<GeocodeResult> {
  try {
    let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;

    if (userLocation) {
      const boxSize = 0.5;
      const viewbox = `${userLocation.lng - boxSize},${userLocation.lat + boxSize},${userLocation.lng + boxSize},${userLocation.lat - boxSize}`;
      url += `&viewbox=${viewbox}&bounded=0`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "TableStack-OpenDeliver/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = await response.json();

    if (data && data.length > 0) {
      return {
        success: true,
        result: {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          displayName: data[0].display_name,
        },
      };
    }

    return { success: false, error: "Location not found" };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reverse geocode coordinates to get address information
 * @param lat - Latitude
 * @param lng - Longitude
 * @returns GeocodeResult with address details
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodeResult> {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "TableStack-OpenDeliver/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Photon reverse geocoding error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.features && data.features.length > 0) {
      const props = data.features[0].properties;
      return {
        success: true,
        result: {
          lat,
          lng,
          displayName:
            props.name || props.street || props.city || "Unknown location",
          address: {
            street: props.street,
            city: props.city,
            postcode: props.postcode,
            country: props.country,
            state: props.state,
          },
        },
      };
    }

    return { success: false, error: "No address found for coordinates" };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Calculate distance between two GPS coordinates using Haversine formula.
 * Returns distance in kilometers.
 *
 * @param lat1 - Latitude of point 1
 * @param lng1 - Longitude of point 1
 * @param lat2 - Latitude of point 2
 * @param lng2 - Longitude of point 2
 * @returns Distance in kilometers
 */
export function calculateHaversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}
