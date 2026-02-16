import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import { normalizeLocation } from "./mobility";
import { WeatherSchema, UnifiedLocationSchema } from "@repo/mcp-protocol";

export type WeatherParams = z.infer<typeof WeatherSchema>;

export const weatherReturnSchema = {
  location: "string",
  temperature_c: "number",
  condition: "string",
  humidity: "number",
  wind_speed_kmh: "number"
};

import { geocode_location } from "./location_search";

export async function get_weather(params: WeatherParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = WeatherSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }
  
  let { location, date } = validated.data;
  let lat: number;
  let lon: number;

  if (typeof location === "string") {
    const geo = await geocode_location({ location });
    if (geo.success && geo.result) {
      lat = geo.result.lat;
      lon = geo.result.lon;
    } else {
      return { success: false, error: "Could not geocode location: " + location };
    }
  } else {
    lat = location.lat;
    lon = location.lon;
  }

  const normalizedLocation = normalizeLocation(location);
  console.log(`Getting functional weather for ${normalizedLocation} (${lat}, ${lon})...`);
  
  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,windspeed_10m`
    );
    
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
        wind_speed_kmh: current.windspeed
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message };
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
  description: "Gets weather forecast for a specific location and optional date for temporal planning context.",
  inputSchema: {
    type: "object",
    properties: {
      location: { 
        type: "object", 
        description: "The city or location to get weather for. Can be a string address OR an object with lat/lon coordinates: {lat: number, lon: number, address?: string}" 
      },
      date: { type: "string", description: "The date for the weather forecast in ISO 8601 format." }
    },
    required: ["location"]
  },
  return_schema: weatherReturnSchema,
  timeout_ms: 15000,
  requires_confirmation: false,
  category: "data",
  rate_limits: {
    requests_per_minute: 60,
    requests_per_hour: 1000
  }
};
