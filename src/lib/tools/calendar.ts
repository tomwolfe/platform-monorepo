import { z } from "zod";

export const EventItemSchema = z.object({
  title: z.string().min(1).describe("The name or title of the calendar event (e.g., 'Dinner at Nobu')."),
  start_time: z.string().describe("The start date and time. Use ISO 8601 format (e.g., '2026-02-10T19:00:00Z')."),
  end_time: z.string().describe("The end date and time. Use ISO 8601 format (e.g., '2026-02-10T21:00:00Z')."),
  location: z.string().optional().describe("Physical address or venue name for the event."),
  restaurant_name: z.string().optional().describe("If the event is at a restaurant, its name."),
  restaurant_address: z.string().optional().describe("If the event is at a restaurant, its full address.")
});

export const AddCalendarEventSchema = z.object({
  events: z.array(EventItemSchema).min(1).describe("An array of one or more calendar events to schedule.")
});

export async function add_calendar_event(params: z.infer<typeof AddCalendarEventSchema>) {
  const validated = AddCalendarEventSchema.safeParse(params);
  if (!validated.success) {
    // Fallback for single event if passed directly
    const singleEvent = EventItemSchema.safeParse(params);
    if (singleEvent.success) {
      params = { events: [singleEvent.data] };
    } else {
      return { success: false, error: "Invalid parameters. Expected an array of events." };
    }
  } else {
    params = validated.data;
  }

  const { events } = params;
  
  console.log(`Adding ${events.length} calendar event(s)...`);
  
  const serializedEvents = JSON.stringify(events.map(e => ({
    title: e.title,
    start: e.start_time,
    end: e.end_time,
    location: e.location || e.restaurant_address || "",
    description: (e.restaurant_name || e.restaurant_address)
      ? `Restaurant: ${e.restaurant_name || 'N/A'}
Address: ${e.restaurant_address || 'N/A'}`
      : ""
  })));

  return {
    success: true,
    result: {
      status: "ready",
      count: events.length,
      download_url: `/api/download-ics?events=${encodeURIComponent(serializedEvents)}`,
      events: events.map(e => ({
        title: e.title,
        start_time: e.start_time,
        end_time: e.end_time,
        location: e.location || e.restaurant_address || "",
      }))
    }
  };
}
