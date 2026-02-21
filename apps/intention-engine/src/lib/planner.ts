import { Plan, PlanSchema, Intent } from "./schema";
import { env } from "./config";
import { getToolDefinitions, discoverDynamicTools } from "./tools";

export async function generatePlan(intent: string | Intent, userLocation?: { lat: number; lng: number } | null): Promise<Plan> {
  // Discover dynamic tools before planning
  await discoverDynamicTools().catch(e => console.error("Dynamic tool discovery failed:", e));

  const intentText = typeof intent === "string" ? intent : intent.rawText;

  const apiKey = env.LLM_API_KEY;
  const baseUrl = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;

  const locationContext = userLocation
    ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}. 
       YOU MUST use these coordinates for all searches and delivery requests. 
       Do not use default cities like London or San Francisco.
       If the user asks for 'nearby' services, use these exact coordinates.`
    : "Location unknown. Ask the user for their address before proceeding.";

  if (!apiKey) {
    // For demonstration purposes if no API key is provided, we return a mock plan
    // for specific examples
    const text = intentText.toLowerCase();

    if (text.includes("dinner") && (text.includes("calendar") || text.includes("book"))) {
      const temporalExpr = typeof intent === "object" ? intent.parameters.temporal_expression : null;
      const reservationTime = temporalExpr ? new Date(temporalExpr as string).toISOString() : new Date(Date.now() + 86400000).toISOString().split('T')[0] + "T19:00:00Z";

      // Use userLocation if available, otherwise require explicit location parameter
      const location = typeof intent === "object"
        ? intent.parameters.location || (userLocation ? `${userLocation.lat}, ${userLocation.lng}` : null)
        : (userLocation ? `${userLocation.lat}, ${userLocation.lng}` : null);

      if (!location) {
        throw new Error("Location required for dinner planning. Provide coordinates or a location parameter.");
      }

      const steps = [
        {
          id: crypto.randomUUID(),
          step_number: 0,
          tool_name: "search_restaurant",
          tool_version: "1.0.0",
          parameters: {
            cuisine: "Italian",
            location: location
          },
          dependencies: [],
          requires_confirmation: false,
          timeout_ms: 30000,
          description: `Search for a highly-rated Italian restaurant in ${location}.`,
        },
        {
          id: crypto.randomUUID(),
          step_number: 1,
          tool_name: "book_restaurant_table",
          tool_version: "1.0.0",
          parameters: {
            restaurant_name: "{{step_0.result[0].name}}",
            date: reservationTime.split('T')[0],
            time: reservationTime.split('T')[1].substring(0, 5),
            party_size: 2
          },
          dependencies: [],
          requires_confirmation: true,
          timeout_ms: 30000,
          description: "Book a table for 2 at the selected restaurant.",
        },
        {
          id: crypto.randomUUID(),
          step_number: 2,
          tool_name: "send_comm",
          tool_version: "1.0.0",
          parameters: {
            to: "me",
            channel: "sms",
            message: "Reminder: Dinner at {{step_0.result[0].name}} tonight at 7 PM."
          },
          dependencies: [],
          requires_confirmation: true,
          timeout_ms: 30000,
          description: "Send a reminder SMS about the reservation."
        }
      ];

      return {
        id: crypto.randomUUID(),
        intent_id: typeof intent === "object" ? intent.id : crypto.randomUUID(),
        steps,
        constraints: {
          max_steps: 10,
          max_total_tokens: 100000,
          max_execution_time_ms: 300000,
        },
        metadata: {
          version: "1.0.0",
          created_at: new Date().toISOString(),
          planning_model_id: model,
          estimated_total_tokens: 1000,
          estimated_latency_ms: 5000,
        },
        summary: "I will find an Italian restaurant, book a table for 7 PM, and send you a reminder SMS."
      };
    }

    if (text.includes("restaurant") && text.includes("book") && text.includes("sms")) {
       const userLocStr = userLocation ? `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}` : "nearby";
       const steps = [
        {
          id: crypto.randomUUID(),
          step_number: 0,
          tool_name: "search_restaurant",
          tool_version: "1.0.0",
          parameters: { location: userLocStr },
          dependencies: [],
          requires_confirmation: false,
          timeout_ms: 30000,
          description: `Finding restaurants near ${userLocStr}.`,
        },
        {
          id: crypto.randomUUID(),
          step_number: 1,
          tool_name: "book_restaurant_table",
          tool_version: "1.0.0",
          parameters: {
            restaurant_name: "{{step_0.result[0].name}}",
            date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
            time: "19:00",
            party_size: 2
          },
          dependencies: [],
          requires_confirmation: true,
          timeout_ms: 30000,
          description: "Booking the table.",
        },
        {
          id: crypto.randomUUID(),
          step_number: 2,
          tool_name: "send_comm",
          tool_version: "1.0.0",
          parameters: {
            to: "me",
            channel: "sms",
            message: "Booked!"
          },
          dependencies: [],
          requires_confirmation: false,
          timeout_ms: 30000,
          description: "Sending SMS reminder."
        }
      ];

      return {
        id: crypto.randomUUID(),
        intent_id: typeof intent === "object" ? intent.id : crypto.randomUUID(),
        steps,
        constraints: {
          max_steps: 10,
          max_total_tokens: 100000,
          max_execution_time_ms: 300000,
        },
        metadata: {
          version: "1.0.0",
          created_at: new Date().toISOString(),
          planning_model_id: model,
          estimated_total_tokens: 1000,
          estimated_latency_ms: 5000,
        },
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

          If a tool is unavailable, use the most similar available tool or provide a general recommendation based on common knowledge in the 'summary'.

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
          1. For restaurant requests, always follow the "Find -> Check -> Book" sequence:
             a. Use 'discover_restaurant' with the restaurant name/slug to get the 'restaurantId'.
             b. Use 'check_availability' with the 'restaurantId', date, and partySize to find available tables.
             c. Use 'book_tablestack_reservation' with the 'restaurantId' and a specific 'tableId' from the availability results.
          2. Restaurant search and user confirmation MUST precede calendar event creation.
          3. Always assume a 2-hour duration for dinner events.
          4. For romantic or high-end dinner requests:
             - Prioritize 'romantic' or 'fine dining' atmosphere in search or description.
             - EXPLICITLY REJECT fast-food chains or low-end casual spots (e.g., McDonald's, Pizza Hut) even if they match the cuisine.
             - NEVER suggest pizza or Mexican cuisine for 'romantic' requests.
          5. When adding a calendar event for a restaurant, include the 'restaurant_name' and 'restaurant_address' in the parameters.
          6. Always use coordinates from \`geocode_location\` if you use that tool, instead of passing the raw location string to \`search_restaurant\`.
          7. For 'add_calendar_event', always provide an array of events under the 'events' key.

          **SYSTEM 2 REASONING - MERGE RULE** (CRITICAL):
          When a user request contains MULTIPLE related intents (e.g., "dinner and a ride", "book table and send invite"):
          1. DO NOT create separate plans for each intent
          2. Create a SINGLE Atomic Saga with combined steps
          3. Use dependency graphs: later steps depend on earlier step results
          4. Example: "I want dinner at Italian place and need a ride home"
             - Step 0: search_restaurant (cuisine: Italian)
             - Step 1: book_restaurant_table (depends on Step 0 result)
             - Step 2: add_calendar_event (depends on Step 1 confirmation)
             - Step 3: get_route_estimate (origin: restaurant from Step 1, destination: user home)
             - Step 4: request_ride (depends on Step 3 estimate, scheduled after Step 2 event time)
          5. Example: "Book table at Pesto Place and invite John and Sarah"
             - Step 0: discover_restaurant (name: "Pesto Place")
             - Step 1: check_availability (restaurantId from Step 0)
             - Step 2: book_tablestack_reservation (tableId from Step 1)
             - Step 3: send_comm (to: John, about: reservation from Step 2)
             - Step 4: send_comm (to: Sarah, about: reservation from Step 2)
          6. Temporal/spatial coupling indicates merge requirement:
             - Same time reference → merge
             - Same location reference → merge
             - Causal dependency (B needs A's result) → merge

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
          
          If a tool is unavailable, use the most similar available tool or provide a general recommendation based on common knowledge in the 'summary'.

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
