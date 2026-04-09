import { z } from "zod";
import { WeatherDataSchema } from "@repo/mcp-protocol";
import { fetchWithTracing } from "../fetch";
import { ToolExecutionContext } from "../engine/tools/registry";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine-weather" });

export const weatherReturnSchema = {
  location: "string",
  temperature_c: "number",
  condition: "string",
  humidity: "number",
  wind_speed_kmh: "number",
};

export type WeatherDataParams = z.infer<typeof WeatherDataSchema>;

export async function get_weather_data(
  params: WeatherDataParams,
  context?: ToolExecutionContext,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = WeatherDataSchema.safeParse(params);
  if (!validated.success) {
    return {
      success: false,
      error: "Invalid parameters: " + validated.error.message,
    };
  }

  const { lat, lon } = validated.data;

  logger.info("Fetching weather data", { lat, lon });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const response = await fetchWithTracing(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,windspeed_10m`,
        { signal: controller.signal },
        context?.executionId,
        context?.abortSignal || controller.signal,
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
          location: `${lat}, ${lon}`,
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
