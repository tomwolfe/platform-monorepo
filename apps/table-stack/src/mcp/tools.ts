import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const CHECK_AVAILABILITY_TOOL: Tool = {
  name: "check_availability",
  description: "Checks real-time table availability for a restaurant. Returns available tables and suggested slots if the requested time is full.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      date: { type: "string", description: "ISO 8601 date and time (e.g., '2026-02-12T19:00:00Z')." },
      partySize: { type: "number", description: "Number of guests." }
    },
    required: ["restaurantId", "date", "partySize"]
  }
};

export const BOOK_RESERVATION_TOOL: Tool = {
  name: "book_tablestack_reservation",
  description: "Finalizes a reservation on TableStack using a specific table ID. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      tableId: { type: "string", description: "The ID of the table to book (obtained from availability)." },
      guestName: { type: "string", description: "The name for the reservation." },
      guestEmail: { type: "string", description: "The email for the reservation." },
      partySize: { type: "number", description: "Number of guests." },
      startTime: { type: "string", description: "ISO 8601 start time." },
      is_confirmed: { type: "boolean", description: "Set to true ONLY if the user has explicitly confirmed these specific details." }
    },
    required: ["restaurantId", "tableId", "guestName", "guestEmail", "partySize", "startTime"]
  }
};

export const DISCOVER_RESTAURANT_TOOL: Tool = {
  name: "discover_restaurant",
  description: "Resolves a restaurant slug to its internal ID and metadata using the TableStack API.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_slug: { type: "string", description: "The slug of the restaurant (e.g., 'the-fancy-bistro')." }
    },
    required: ["restaurant_slug"]
  }
};

export const TOOL_METADATA = {
  check_availability: { requires_confirmation: false },
  book_tablestack_reservation: { requires_confirmation: true },
  discover_restaurant: { requires_confirmation: false }
};
