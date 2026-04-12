import { z } from "zod";
import { ToolDefinitionMetadata } from "./types";
import { normalizeLocation } from "./mobility";
import { WeatherSchema } from "@repo/mcp-protocol";
import {
  withNervousSystemTracing,
  injectTracingHeaders,
} from "@repo/shared/tracing";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "tool-context" });

export type WeatherParams = z.infer<typeof WeatherSchema>;

export const weatherReturnSchema = {
  location: "string",
  temperature_c: "number",
  condition: "string",
  humidity: "number",
  wind_speed_kmh: "number",
};

import { geocode_location } from "./location_search";

export async function get_weather(
  params: WeatherParams,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const validated = WeatherSchema.safeParse(params);
  if (!validated.success) {
    return {
      success: false,
      error: "Invalid parameters: " + validated.error.message,
    };
  }

  let { location } = validated.data;
  let lat: number;
  let lon: number;

  if (typeof location === "string") {
    const geo = await geocode_location({ location });
    if (geo.success && geo.result) {
      lat = geo.result.lat;
      lon = geo.result.lon;
    } else {
      return {
        success: false,
        error: "Could not geocode location: " + location,
      };
    }
  } else {
    lat = location.lat;
    lon = location.lon;
  }

  const normalizedLocation = normalizeLocation(location);
  logger.debug("Getting weather for location", {
    normalizedLocation,
    lat,
    lon,
  });

  try {
    return await withNervousSystemTracing(async ({ correlationId }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,windspeed_10m`,
          {
            headers: injectTracingHeaders({}, correlationId),
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Weather API error: ${response.statusText}`);
        }

        const data = await response.json();
        const current = data.current_weather;

        return {
          success: true,
          result: {
            location: normalizedLocation,
            temperature_c: current.temperature,
            condition: getWeatherCondition(current.weathercode),
            humidity: data.hourly.relativehumidity_2m[0],
            wind_speed_kmh: current.windspeed,
          },
        };
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    });
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getWeatherCondition(code: number): string {
  // Mapping WMO Weather interpretation codes
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Mainly clear, partly cloudy, and overcast";
  if (code <= 48) return "Fog and depositing rime fog";
  if (code <= 55) return "Drizzle: Light, moderate, and dense intensity";
  if (code <= 65) return "Rain: Slight, moderate and heavy intensity";
  if (code <= 77) return "Snow fall: Slight, moderate, and heavy intensity";
  if (code <= 82) return "Rain showers: Slight, moderate, and violent";
  if (code <= 99) return "Thunderstorm: Slight or moderate";
  return "Unknown";
}

export const getWeatherToolDefinition: ToolDefinitionMetadata = {
  name: "get_weather",
  version: "1.0.0",
  description:
    "Gets weather forecast for a specific location and optional date for temporal planning context.",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "object",
        description:
          "The city or location to get weather for. Can be a string address OR an object with lat/lon coordinates: {lat: number, lon: number, address?: string}",
      },
      date: {
        type: "string",
        description: "The date for the weather forecast in ISO 8601 format.",
      },
    },
    required: ["location"],
  },
  return_schema: weatherReturnSchema,
  timeout_ms: 15000,
  requires_confirmation: false,
  category: "data",
  rate_limits: {
    requests_per_minute: 60,
    requests_per_hour: 1000,
  },
};
