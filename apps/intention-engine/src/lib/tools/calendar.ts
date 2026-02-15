import { z } from "zod";
import { AddCalendarEventSchema, EventItemSchema } from "@repo/mcp-protocol";

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
