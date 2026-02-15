import { z } from "zod";
import { UnifiedLocationSchema } from "./mobility";

export const WeatherSchema = z.object({
  location: UnifiedLocationSchema.describe("The city or location to get weather for. Can be a string address OR an object with lat/lon coordinates."),
  date: z.string().optional().describe("The date for the weather forecast in ISO 8601 format.")
});
