import { z } from "zod";
import { WeatherDataSchema } from "@repo/mcp-protocol";

export const weatherReturnSchema = {
  location: "string",
  temperature_c: "number",
  condition: "string",
  humidity: "number",
  wind_speed_kmh: "number"
};

export type WeatherDataParams = z.infer<typeof WeatherDataSchema>;

export async function get_weather_data(params: WeatherDataParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = WeatherDataSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }
  
  const { lat, lon } = validated.data;

  console.log(`Getting weather data for coordinates (${lat}, ${lon})...`);
  
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
        location: `${lat}, ${lon}`,
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
