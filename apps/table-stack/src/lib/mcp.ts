export const GET_AVAILABILITY_TOOL = {
  name: "get_availability",
  description: "Check table availability for a specific restaurant, date, and party size.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_id: {
        type: "string",
        description: "The UUID of the restaurant to check."
      },
      date: {
        type: "string",
        description: "The ISO 8601 date and time for the reservation (e.g., '2026-02-14T19:00:00Z')."
      },
      party_size: {
        type: "number",
        description: "The number of people in the party."
      }
    },
    required: ["restaurant_id", "date", "party_size"]
  }
};

export const TOOL_METADATA = {
  get_availability: {
    requires_confirmation: false
  }
};

export const PARAMETER_ALIASES = {
  "venue_id": "restaurant_id",
  "reservation_time": "date",
  "guests": "party_size"
};
