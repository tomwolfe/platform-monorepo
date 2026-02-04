export async function search_restaurant(params: { cuisine: string; location: string }) {
  // Mock implementation
  console.log(`Searching for ${params.cuisine} in ${params.location}...`);
  return {
    success: true,
    result: {
      name: "Bella Italia",
      address: "123 Pasta Lane",
      rating: 4.5,
      recommendation: "Try the Carbonara."
    }
  };
}

export async function add_calendar_event(params: { title: string; start_time: string; end_time: string }) {
  // Mock implementation
  console.log(`Adding calendar event: ${params.title} from ${params.start_time} to ${params.end_time}...`);
  return {
    success: true,
    result: {
      event_id: "cal_12345",
      status: "confirmed",
      link: "https://calendar.google.com/event?id=cal_12345"
    }
  };
}

export const TOOLS: Record<string, Function> = {
  search_restaurant,
  add_calendar_event,
};

export async function executeTool(tool_name: string, parameters: any) {
  const tool = TOOLS[tool_name];
  if (!tool) {
    throw new Error(`Tool ${tool_name} not found`);
  }
  return await tool(parameters);
}
