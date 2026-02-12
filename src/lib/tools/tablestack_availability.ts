import { z } from "zod";
import { ToolDefinitionMetadata } from "./types";
import { env } from "../config";

export const TableAvailabilitySchema = z.object({
  restaurantId: z.string().describe("The internal ID of the restaurant."),
  date: z.string().describe("The date and time for availability (ISO 8601 format, e.g., '2026-02-12T19:00:00Z')."),
  partySize: z.number().int().positive().describe("Number of people in the party."),
});

export type TableAvailabilityParams = z.infer<typeof TableAvailabilitySchema>;

export async function check_availability(params: TableAvailabilityParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = TableAvailabilitySchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + JSON.stringify(validated.error.format()) };
  }

  const { restaurantId, date, partySize } = validated.data;

  try {
    const url = new URL(`${env.TABLESTACK_API_URL}/availability`);
    url.searchParams.append("restaurantId", restaurantId);
    url.searchParams.append("date", date);
    url.searchParams.append("partySize", partySize.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        result: data
      };
    }

    const errorData = await response.json();
    return { success: false, error: errorData.message || "Failed to check availability" };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export const checkAvailabilityToolDefinition: ToolDefinitionMetadata = {
  name: "check_availability",
  version: "1.0.0",
  description: "Checks real-time table availability for a restaurant. Returns available tables and suggested slots if the requested time is full.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      date: { type: "string", description: "ISO 8601 date and time." },
      partySize: { type: "number", description: "Number of guests." }
    },
    required: ["restaurantId", "date", "partySize"]
  },
  return_schema: {
    restaurantId: "string",
    requestedTime: "string",
    partySize: "number",
    availableTables: "array",
    suggestedSlots: "array"
  },
  timeout_ms: 20000,
  requires_confirmation: false,
  category: "search",
};
