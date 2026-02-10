import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, convertToModelMessages } from "ai";
import { z } from "zod";
import { search_restaurant, add_calendar_event, geocode_location } from "@/lib/tools";
import { env } from "@/lib/config";
import { inferIntent } from "@/lib/intent";

export const runtime = "edge";
export const maxDuration = 30;

const openai = createOpenAI({
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL,
});

const ChatRequestSchema = z.object({
  messages: z.array(z.any()),
  userLocation: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const rawBody = await req.json();
    const validatedBody = ChatRequestSchema.safeParse(rawBody);

    if (!validatedBody.success) {
      return new Response(JSON.stringify({ error: "Invalid request parameters", details: validatedBody.error.format() }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { messages, userLocation } = validatedBody.data;

    if (messages.length === 0) {
      return new Response("No messages provided", { status: 400 });
    }

    const coreMessages = await convertToModelMessages(messages);

    // Phase 4: Consume structured intent to drive logic
    const lastUserMessage = [...coreMessages].reverse().find(m => m.role === "user");
    let userText = "";
    if (typeof lastUserMessage?.content === "string") {
      userText = lastUserMessage.content;
    } else if (Array.isArray(lastUserMessage?.content)) {
      userText = lastUserMessage.content
        .filter(part => part.type === "text")
        .map(part => (part as any).text)
        .join("\n");
    }

    let intent;
    try {
      const inferenceResult = await inferIntent(userText);
      intent = inferenceResult.intent;
      console.log("[Phase 4] Structured Intent Inferred:", intent.type, "Confidence:", intent.confidence);
    } catch (e) {
      console.error("Intent inference failed, falling back to UNKNOWN", e);
      intent = { type: "UNKNOWN", confidence: 0, entities: {}, rawText: userText };
    }

    const locationContext = userLocation 
      ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}.`
      : "The user's location is unknown.";

    // Logic driven by intent:
    // 1. Dynamic System Prompt
    // 2. Filtered Toolset
    let systemPrompt = `You are an Intention Engine.
    The user's inferred intent is: ${intent.type} (Confidence: ${intent.confidence})
    Extracted Entities: ${JSON.stringify(intent.entities)}
    
    ${locationContext}
    `;

    const allTools = {
      geocode_location: tool({
        description: "Converts a city or place name to lat/lon coordinates.",
        inputSchema: z.object({
          location: z.string().describe("The city or place name to geocode"),
        }),
        execute: async (params) => {
          console.log("Executing geocode_location", params);
          return await geocode_location(params);
        },
      }),
      search_restaurant: tool({
        description: "Search for restaurants nearby based on cuisine and location.",
        inputSchema: z.object({
          cuisine: z.string().optional().describe("The type of cuisine, e.g. 'Italian', 'Sushi'"),
          lat: z.number().optional().describe("The latitude coordinate"),
          lon: z.number().optional().describe("The longitude coordinate"),
          location: z.string().optional().describe("The city or place name if lat/lon are not available"),
        }),
        execute: async (params: any) => {
          console.log("Executing search_restaurant", params);
          return await search_restaurant(params);
        },
      }),
      add_calendar_event: tool({
        description: "Add an event to the user's calendar.",
        inputSchema: z.object({
          title: z.string().describe("The title of the event"),
          start_time: z.string().describe("The start time in ISO format"),
          end_time: z.string().describe("The end time in ISO format"),
          location: z.string().optional().describe("The location of the event"),
          restaurant_name: z.string().optional().describe("Name of the restaurant"),
          restaurant_address: z.string().optional().describe("Address of the restaurant"),
        }),
        execute: async (params: any) => {
          console.log("Executing add_calendar_event", params);
          return await add_calendar_event(params);
        },
      }),
    };

    // Filter tools based on intent to minimize surface area (Phase 4 Logic)
    let enabledTools: any = {};
    if (intent.type === "SEARCH" || intent.type === "UNKNOWN") {
      enabledTools.search_restaurant = allTools.search_restaurant;
      enabledTools.geocode_location = allTools.geocode_location;
    }
    if (intent.type === "SCHEDULE" || intent.type === "UNKNOWN") {
      enabledTools.add_calendar_event = allTools.add_calendar_event;
    }
    if (intent.type === "ACTION") {
      enabledTools = allTools; // Action can be anything
    }

    const result = streamText({
      model: openai.chat(env.LLM_MODEL),
      messages: coreMessages,
      system: systemPrompt,
      tools: enabledTools,
      stopWhen: stepCountIs(5),
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
    });
  } catch (error: any) {
    console.error("Error in chat route:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
