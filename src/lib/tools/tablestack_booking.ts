import { z } from "zod";
import { ToolDefinitionMetadata } from "./types";
import { env } from "../config";

export const TableStackBookingSchema = z.object({
  restaurantId: z.string().describe("The internal ID of the restaurant."),
  tableId: z.string().describe("The ID of the table to book (obtained from availability)."),
  guestName: z.string().describe("The name for the reservation."),
  guestEmail: z.string().email().describe("The email for the reservation."),
  partySize: z.number().int().positive().describe("Number of people in the party."),
  startTime: z.string().describe("The start time of the reservation (ISO 8601 format)."),
  is_confirmed: z.boolean().default(false).describe("Set to true ONLY if the user has explicitly confirmed these specific details.")
});

export type TableStackBookingParams = z.infer<typeof TableStackBookingSchema>;

export async function book_tablestack_reservation(params: TableStackBookingParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = TableStackBookingSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + JSON.stringify(validated.error.format()) };
  }

  const { 
    restaurantId, tableId, guestName, guestEmail, partySize, startTime, is_confirmed 
  } = validated.data;

  if (!is_confirmed) {
    return {
      success: false,
      error: `CONFIRMATION_REQUIRED: Please confirm booking for ${guestName} at ${startTime} for ${partySize} guests.`
    };
  }

  try {
    const response = await fetch(`${env.TABLESTACK_API_URL}/reserve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.TABLESTACK_INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        restaurantId,
        tableId,
        guestName,
        guestEmail,
        partySize,
        startTime,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        result: {
          status: "confirmed",
          message: data.message,
          booking_id: data.bookingId,
        }
      };
    }

    const errorData = await response.json();
    return { success: false, error: errorData.message || "Failed to reserve table" };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export const bookTableStackToolDefinition: ToolDefinitionMetadata = {
  name: "book_tablestack_reservation",
  version: "1.0.0",
  description: "Finalizes a reservation on TableStack using a specific table ID.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      tableId: { type: "string", description: "The ID of the table to book." },
      guestName: { type: "string", description: "The name for the reservation." },
      guestEmail: { type: "string", description: "The email for the reservation." },
      partySize: { type: "number", description: "Number of guests." },
      startTime: { type: "string", description: "ISO 8601 start time." },
      is_confirmed: { type: "boolean", description: "Set to true only if the user has explicitly confirmed." }
    },
    required: ["restaurantId", "tableId", "guestName", "guestEmail", "partySize", "startTime"]
  },
  return_schema: {
    status: "string",
    message: "string",
    booking_id: "string"
  },
  timeout_ms: 30000,
  requires_confirmation: true,
  category: "action",
  parameter_aliases: {
    "party size": "partySize",
    "how many people": "partySize",
    "when": "startTime"
  },
  rate_limits: {
    requests_per_minute: 10,
    requests_per_hour: 100
  }
};
