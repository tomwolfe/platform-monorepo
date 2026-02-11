import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import { UnifiedLocationSchema, normalizeLocation } from "./mobility";

export const WeatherSchema = z.object({
  location: UnifiedLocationSchema.describe("The city or location to get weather for. Can be a string address OR an object with lat/lon coordinates."),
  date: z.string().optional().describe("The date for the weather forecast in ISO 8601 format.")
});

export type WeatherParams = z.infer<typeof WeatherSchema>;

export const weatherReturnSchema = {
  location: "string",
  temperature_c: "number",
  condition: "string",
  humidity: "number",
  wind_speed_kmh: "number"
};

export async function get_weather(params: WeatherParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = WeatherSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }
  
  const { location, date } = validated.data;
  const normalizedLocation = normalizeLocation(location);
  console.log(`Getting weather for ${normalizedLocation}${date ? ' on ' + date : ''}...`);
  
  try {
    // Placeholder for actual weather API integration
    // In production, this would integrate with OpenWeatherMap, WeatherAPI, etc.
    // const apiKey = process.env.WEATHER_API_KEY; // Placeholder for API key
    
    return {
      success: true,
      result: {
        location: normalizedLocation,
        temperature_c: 22,
        condition: "Partly Cloudy",
        humidity: 45,
        wind_speed_kmh: 15
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
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
