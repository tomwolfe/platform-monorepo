import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, convertToModelMessages, generateObject } from "ai";
import { z } from "zod";
import { 
  search_restaurant, 
  add_calendar_event, 
  geocode_location, 
  getToolCapabilitiesPrompt, 
  listTools 
} from "@/lib/tools";
import { UnifiedLocationSchema } from "@/lib/tools/mobility";
import { env } from "@/lib/config";
import { inferIntent } from "@/lib/intent";
import { Redis } from "@upstash/redis";
import { getUserPreferences, updateUserPreferences } from "@/lib/preferences";
import { redis } from "@/lib/redis-client";
import { getMcpClients } from "@/lib/mcp-client";
import { 
  TOOLS, 
  McpToolRegistry, 
  GeocodeSchema, 
  AddCalendarEventSchema,
  SearchRestaurantSchema,
  WeatherDataSchema,
  RouteEstimateSchema,
  MobilityRequestSchema,
  TableReservationSchema,
  CommunicationSchema,
  FindProductNearbySchema,
  ReserveStockItemSchema,
  CreateProductSchema,
  UpdateProductSchema,
  DeleteProductSchema,
  GetLiveOperationalStateSchema,
  DB_REFLECTED_SCHEMAS
} from "@repo/mcp-protocol";
import { NormalizationService } from "@repo/shared";

export const runtime = "nodejs";
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

/**
 * Dynamically fetches tools from all registered MCP servers.
 * Uses centralized McpToolRegistry schemas for validation.
 */
async function getTools(auditLogId: string, userLocation?: { lat: number, lng: number }) {
  const clients = await getMcpClients();
  const tools: Record<string, any> = {};

  // Helper to get schema from McpToolRegistry
  const getSchemaForTool = (toolName: string): z.ZodType<any> | undefined => {
    // Flatten the TOOLS registry to find matching schema
    const allTools = Object.values(TOOLS).flatMap(service => Object.values(service));
    const toolDef = allTools.find(t => (t as any).name === toolName);
    return (toolDef as any)?.schema;
  };

  for (const [serviceName, client] of Object.entries(clients)) {
    try {
      const { tools: mcpTools } = await client.listTools();
      
      for (const mcpTool of mcpTools) {
        // Use schema from registry if available, fallback to generic
        const registrySchema = getSchemaForTool(mcpTool.name);
        
        tools[mcpTool.name] = tool({
          description: mcpTool.description,
          inputSchema: registrySchema || z.record(z.any()), 
          execute: async (params) => {
            console.log(`Executing MCP tool ${mcpTool.name} from ${serviceName}`, params);
            
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: {
                ...params,
                userLocation // Inject context if needed
              }
            });
            
            return result;
          },
        });
      }
    } catch (error) {
      console.error(`Error listing tools for ${serviceName}:`, error);
    }
  }
  
  return tools;
}

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

    const startTime = Date.now();

    // Stateful Memory: Retrieve user preferences from Redis
    const userIp = req.headers.get("x-forwarded-for") || "anonymous";
    const userPrefsKey = `prefs:${userIp}`;
    let userPreferences = null;
    let recentLogs: any[] = [];

    const { createAuditLog, updateAuditLog, getUserAuditLogs } = await import("@/lib/audit");
    const { executeToolWithContext, getPlanWithAvoidance, getProvider } = await import("@/app/actions");

    if (redis) {
      try {
        [userPreferences, recentLogs] = await Promise.all([
          getUserPreferences(userIp),
          getUserAuditLogs(userIp, 10)
        ]);
      } catch (err) {
        console.warn("Failed to retrieve user data from Redis:", err);
      }
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

    // Step 2: Semantic Memory & Proactive Retrieval
    const getRelevantFailures = function(text: string, logs: any[]) {
      const keywords = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const failures: string[] = [];
      for (const log of logs) {
        if (log.steps) {
          for (const step of log.steps) {
            if (step.status === "failed") {
              const inputStr = JSON.stringify(step.input).toLowerCase();
              const hasOverlap = keywords.some(k => inputStr.includes(k));
              
              if (hasOverlap) {
                let specificWarning = `Previous attempt at ${step.tool_name} with parameters ${JSON.stringify(step.input)} failed with error: "${step.error}".`;
                failures.push(specificWarning);
              }
            }
          }
        }
      }
      return Array.from(new Set(failures)).slice(0, 3);
    }

    const relevantFailures = getRelevantFailures(userText, recentLogs);
    const failureWarnings = relevantFailures.length > 0
      ? `\n### DO NOT REPEAT THESE MISTAKES:\n${relevantFailures.map(f => `- ${f}`).join('\n')}`
      : "";

    let intent;
    let intentInferenceLatency = 0;
    let rawModelResponse = "";
    try {
      const intentStart = Date.now();
      const { avoidTools } = await getPlanWithAvoidance(userText, userIp);
      const inferenceResult = await inferIntent(userText, avoidTools);
      intentInferenceLatency = Date.now() - intentStart;
      intent = inferenceResult.hypotheses.primary;
      rawModelResponse = inferenceResult.rawResponse;
      
      // Phase 3: Deterministic Intelligence Guardrails
      // Validate intent parameters against McpToolRegistry schemas
      // This overrides LLM "Confidence Inflation" with deterministic Zod failures
      const normalizationResult = NormalizationService.normalizeIntentParameters(
        intent.type,
        intent.parameters || {}
      );
      
      if (!normalizationResult.success) {
        console.warn("[NormalizationService] Intent parameter validation failed:", {
          intentType: intent.type,
          errors: normalizationResult.errors
        });
        // Reduce confidence if parameters fail validation
        intent.confidence = Math.min(intent.confidence * 0.5, 0.3);
      } else if (normalizationResult.data) {
        // Replace parameters with normalized/validated version
        intent.parameters = normalizationResult.data as Record<string, unknown>;
      }
    } catch (e) {
      console.error("Intent inference failed, falling back to UNKNOWN", e);
      intent = { 
        id: crypto.randomUUID(),
        type: "UNKNOWN", 
        confidence: 0, 
        parameters: {}, 
        rawText: userText,
        metadata: { version: "1.0.0", timestamp: new Date().toISOString(), source: "error_fallback" }
      } as any;
    }

    // Initialize Audit Log
    const auditLog = await createAuditLog(intent, undefined, userLocation || undefined, userIp);
    
    // Fetch dynamic tools from MCP servers
    const mcpTools = await getTools(auditLog.id, userLocation || undefined);
    
    // Build the complete toolset combining MCP and Local tools
    const localTools = listTools();
    const allTools: Record<string, any> = { ...mcpTools };

    const schemaMap: Record<string, z.ZodType<any>> = {
      geocode_location: GeocodeSchema,
      add_calendar_event: AddCalendarEventSchema,
      search_restaurant: SearchRestaurantSchema,
      get_weather_data: WeatherDataSchema,
      get_route_estimate: RouteEstimateSchema,
      request_ride: MobilityRequestSchema,
      book_restaurant_table: DB_REFLECTED_SCHEMAS.createReservation,
      reserve_restaurant: DB_REFLECTED_SCHEMAS.createReservation,
      send_comm: CommunicationSchema,
      find_product_nearby: FindProductNearbySchema,
      reserve_stock_item: ReserveStockItemSchema,
      create_product: CreateProductSchema,
      update_product: UpdateProductSchema,
      delete_product: DeleteProductSchema,
      get_live_operational_state: GetLiveOperationalStateSchema,
    };

    for (const localTool of localTools) {
      // Don't override MCP tools with local ones if they already exist
      if (!allTools[localTool.name]) {
        allTools[localTool.name] = tool({
          description: localTool.description,
          inputSchema: schemaMap[localTool.name] || z.record(z.any()),
          execute: async (params) => {
            // Context Injection: Provide user location if schema expects it
            const enrichedParams = { ...params };
            const needsLocation = ["geocode_location", "search_restaurant"].includes(localTool.name);
            
            if (needsLocation && userLocation && !enrichedParams.userLocation) {
              enrichedParams.userLocation = userLocation;
            }

            const result = await executeToolWithContext(localTool.name, enrichedParams, {
              audit_log_id: auditLog.id,
              step_index: auditLog.steps.length
            });
            return result;
          },
        });
      }
    }

    const locationContext = userLocation 
      ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}.`
      : "The user's location is unknown.";

    const memoryContext = recentLogs.length > 0 
      ? `Recent interaction history:\n${recentLogs.map(l => `- Intent: ${l.intent}, Outcome: ${l.final_outcome || 'N/A'}`).join('\n')}`
      : "";

    const toolCapabilitiesPrompt = getToolCapabilitiesPrompt();
    
    let systemPrompt = `You are an Intention Engine.
    Today's date is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
    The user's inferred intent is: ${intent.type} (Confidence: ${intent.confidence})
    
    ${locationContext}
    ${memoryContext}
    ${failureWarnings}

    If a tool returns success: false, you MUST acknowledge the error and attempt to REPLAN. 

    ${toolCapabilitiesPrompt}
    `;

    const providerConfig = await getProvider(intent.type);
    const customProvider = createOpenAI({
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseUrl,
    });

    const result = streamText({
      model: customProvider.chat(providerConfig.model),
      messages: coreMessages,
      system: systemPrompt,
      tools: allTools,
      stopWhen: stepCountIs(5),
      onFinish: async (event) => {
        const totalLatency = Date.now() - startTime;
        try {
          await (await import("@/lib/audit")).updateAuditLog(auditLog.id, {
            final_outcome: event.text,
            inferenceLatencies: {
              total: totalLatency,
            }
          });
        } catch (err) {
          console.error("Failed to update final audit log:", err);
        }
      }
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
