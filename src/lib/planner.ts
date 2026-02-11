import { Plan, PlanSchema, Intent } from "./schema";
import { env } from "./config";
import { getToolDefinitions } from "./tools";

export async function generatePlan(intent: string | Intent, userLocation?: { lat: number; lng: number } | null): Promise<Plan> {
  const intentText = typeof intent === "string" ? intent : intent.rawText;
  const apiKey = env.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;

  const locationContext = userLocation 
    ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}. Use these coordinates for 'nearby' requests.`
    : "The user's location is unknown. If they ask for 'nearby' or don't specify a location, ask for confirmation or use a sensible default like London (51.5074, -0.1278).";

  if (!apiKey) {
    // For demonstration purposes if no API key is provided, we return a mock plan
    // for specific examples
    const text = intentText.toLowerCase();
    
    if (text.includes("dinner") && (text.includes("calendar") || text.includes("book"))) {
      const temporalExpr = typeof intent === "object" ? intent.parameters.temporal_expression : null;
      const reservationTime = temporalExpr ? new Date(temporalExpr as string).toISOString() : new Date(Date.now() + 86400000).toISOString().split('T')[0] + "T19:00:00Z";
      const location = typeof intent === "object" ? intent.parameters.location || "London" : "London";

      return {
        intent_type: "PLANNING",
        constraints: [`dinner time at 7 PM`, `location: ${location}`],
        ordered_steps: [
          {
            tool_name: "search_restaurant",
            parameters: { 
              cuisine: "Italian", 
              location: location
            },
            requires_confirmation: false,
            description: `Search for a highly-rated Italian restaurant in ${location}.`,
          },
          {
            tool_name: "book_restaurant_table",
            parameters: { 
              restaurant_name: "{{step_0.result[0].name}}", 
              reservation_time: reservationTime,
              party_size: 2
            },
            requires_confirmation: true,
            description: "Book a table for 2 at the selected restaurant.",
          },
          {
            tool_name: "send_comm",
            parameters: {
              to: "me",
              channel: "sms",
              message: "Reminder: Dinner at {{step_0.result[0].name}} tonight at 7 PM."
            },
            requires_confirmation: true,
            description: "Send a reminder SMS about the reservation."
          }
        ],
        summary: "I will find an Italian restaurant, book a table for 7 PM, and send you a reminder SMS."
      };
    }
    
    if (text.includes("restaurant") && text.includes("book") && text.includes("sms")) {
       const userLocStr = userLocation ? `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}` : "nearby";
       return {
        intent_type: "PLANNING",
        constraints: [],
        ordered_steps: [
          {
            tool_name: "search_restaurant",
            parameters: { location: userLocStr },
            requires_confirmation: false,
            description: `Finding restaurants near ${userLocStr}.`,
          },
          {
            tool_name: "book_restaurant_table",
            parameters: { 
              restaurant_name: "{{step_0.result[0].name}}", 
              reservation_time: new Date(Date.now() + 86400000).toISOString().split('T')[0] + "T19:00:00Z",
              party_size: 2
            },
            requires_confirmation: true,
            description: "Booking the table.",
          },
          {
            tool_name: "send_comm",
            parameters: {
              to: "me",
              channel: "sms",
              message: "Booked!"
            },
            requires_confirmation: false,
            description: "Sending SMS reminder."
          }
        ],
        summary: "Finding a restaurant, booking it, and sending you an SMS."
      };
    }

    throw new Error("LLM_API_KEY is not set and no mock available for this intent.");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content: `You are an Intention Engine. Convert user intent into a structured JSON plan.
          Follow this schema strictly:
          {
            "intent_type": "string (e.g., 'dining', 'scheduling', 'communication')",
            "constraints": ["string array of requirements"],
            "ordered_steps": [
              {
                "tool_name": "string",
                "parameters": { "param_name": "value" },
                "requires_confirmation": true/false,
                "description": "string"
              }
            ],
            "summary": "string"
          }

          Context:
          ${locationContext}

          Available tools:
          ${getToolDefinitions()}

          Tool Chaining & Context Injection:
          1. Explicitly map outputs from previous steps to inputs of subsequent steps.
          2. Use the syntax \`{{step_N.result.field}}\` to reference the output of a previous step (where N is the 0-based index of the step).
          3. Example: If Step 0 is \`geocode_location\`, Step 1 should use \`{{step_0.result.lat}}\` and \`{{step_0.result.lon}}\` for its coordinates.
          4. Example: If Step 1 is \`search_restaurant\`, Step 2 (\`add_calendar_event\`) should use \`{{step_1.result[0].name}}\` for \`restaurant_name\` if a specific restaurant selection is implied.

          Location Parameter Guidelines:
          1. Locations can be provided as either a string address (e.g., "123 Main St", "Airport", "Downtown") OR as a coordinate object with lat/lon: {lat: number, lon: number, address?: string}.
          2. For mobility_request: pickup_location and destination_location accept both formats.
          3. For get_route_estimate: origin and destination accept both formats.
          4. Use coordinate objects when you have precise coordinates from previous steps (e.g., from geocode_location).
          5. Use string addresses when the user provides a location name or address.

          Dinner Planning Rules:
          1. Restaurant search and user confirmation MUST precede calendar event creation.
          2. Always assume a 2-hour duration for dinner events.
          3. For romantic dinner requests:
             - Prioritize 'romantic' atmosphere in search or description.
             - NEVER suggest pizza or Mexican cuisine.
          4. When adding a calendar event for a restaurant, include the 'restaurant_name' and 'restaurant_address' in the parameters.
          5. Always use coordinates from \`geocode_location\` if you use that tool, instead of passing the raw location string to \`search_restaurant\`.
          6. For 'add_calendar_event', always provide an array of events under the 'events' key.

          Return ONLY pure JSON. No free text.`
        },
        {
          role: "user",
          content: intentText
        }
      ],
      response_format: { type: "json_object" }
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM call failed: ${error}`);
  }

  const data = await response.json();
  const planJson = JSON.parse(data.choices[0].message.content);
  
  // Validate against schema
  return PlanSchema.parse(planJson);
}

export async function replan(
  originalIntent: string | Intent, 
  auditLog: any, 
  failedStepIndex: number, 
  error: string,
  failedStepContext?: { parameters: any; result: any },
  errorType?: "validation" | "technical" | "logic"
): Promise<Plan> {
  const intentText = typeof originalIntent === "string" ? originalIntent : originalIntent.rawText;
  const apiKey = env.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;

  if (!apiKey) {
    throw new Error("LLM_API_KEY is not set. Re-planning requires LLM access.");
  }

  // Build a concise summary of the execution history for the LLM
  const executionHistory = auditLog.steps.map((s: any) => {
    return `Step ${s.step_index}: ${s.tool_name} -> ${s.status}${s.error ? ` (Error: ${s.error})` : ''}`;
  }).join('\n');

  const contextSnippet = failedStepContext 
    ? `\nFailed Step Context:\nParameters: ${JSON.stringify(failedStepContext.parameters)}\nResult/Output: ${JSON.stringify(failedStepContext.result)}`
    : "";

  const validationInstruction = errorType === "validation" 
    ? "\nYour previous tool parameters were invalid. Do not change the goal, only correct the schema."
    : "";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content: `You are an Intention Engine in Re-planning mode.
          A previous plan failed at step ${failedStepIndex}.
          Specific Error: ${error}
          ${contextSnippet}
          ${validationInstruction}
          
          Original Intent: ${intentText}
          
          Execution History:
          ${executionHistory}
          
          Full Audit Log State: ${JSON.stringify(auditLog)}
          
          Your task is to provide a NEW plan to recover from this error.
          - If a tool failed due to missing information, try to find it in a different way or ask (by adding a step that returns what's needed).
          - If the user's intent cannot be fulfilled exactly, suggest the closest possible alternative.
          - The new plan will replace the remaining steps of the old plan.
          
          Follow this schema strictly:
          {
            "intent_type": "string",
            "constraints": ["string array"],
            "ordered_steps": [
              {
                "tool_name": "string",
                "parameters": { "param_name": "value" },
                "requires_confirmation": true/false,
                "description": "string"
              }
            ],
            "summary": "string"
          }

          Available tools:
          ${getToolDefinitions()}

          Return ONLY pure JSON.`
        }
      ],
      response_format: { type: "json_object" }
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM re-plan call failed: ${errorText}`);
  }

  const data = await response.json();
  const planJson = JSON.parse(data.choices[0].message.content);
  return PlanSchema.parse(planJson);
}
