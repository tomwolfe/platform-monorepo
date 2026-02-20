import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, convertToModelMessages, generateObject } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  search_restaurant,
  add_calendar_event,
  geocode_location,
  getToolCapabilitiesPrompt,
  listTools
} from "@/lib/tools";
import { env } from "@/lib/config";
import { inferIntent } from "@/lib/intent";
import { Redis } from "@upstash/redis";
import { getUserPreferences, updateUserPreferences } from "@/lib/preferences";
import { redis } from "@/lib/redis-client";
import { getMcpClients } from "@/lib/mcp-client";
import { QStashService } from "@repo/shared";
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
  GetLiveOperationalStateSchema,
  DB_REFLECTED_SCHEMAS,
  UnifiedLocationSchema
} from "@repo/mcp-protocol";
import { NormalizationService, FailoverPolicyEngine, type PolicyEvaluationContext } from "@repo/shared";
import { getNervousSystemObserver } from "@/lib/listeners/nervous-system-observer";
import { saveExecutionState, loadExecutionState } from "@/lib/engine/memory";
import { createInitialState, setIntent, setPlan } from "@/lib/engine/state-machine";
import { parseIntent as engineParseIntent } from "@/lib/engine/intent";
import { generatePlan as engineGeneratePlan } from "@/lib/engine/planner";
import { getRegistryManager } from "@/lib/engine/registry";
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";

// Internal system key for QStash-triggered requests
const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "internal-system-key-change-in-production";

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
 * Trigger async execution for saga-type operations
 * 
 * This function creates an execution state and triggers QStash to run the plan
 * asynchronously using the recursive self-trigger pattern.
 * 
 * @param intent - The parsed intent
 * @param userContext - User context (userId, clerkId, etc.)
 * @param auditLogId - Audit log ID for tracing
 * @returns Execution ID for tracking
 */
async function triggerAsyncExecution(
  intent: any,
  userContext: { userId?: string; clerkId?: string; userEmail?: string },
  auditLogId: string
): Promise<string> {
  const executionId = randomUUID();
  
  try {
    // Create initial state
    let state = createInitialState(executionId);
    state = setIntent(state, intent);
    
    // Generate plan
    const registryManager = getRegistryManager();
    const planResult = await engineGeneratePlan(intent, {
      execution_id: executionId,
      available_tools: registryManager.listAllTools(),
    });
    
    // Verify plan
    const verification = verifyPlan(planResult.plan, DEFAULT_SAFETY_POLICY);
    if (!verification.valid) {
      throw new Error(verification.reason || "Plan verification failed");
    }
    
    state = setPlan(state, planResult.plan);
    await saveExecutionState(state);
    
    // Trigger first step via QStash
    await QStashService.triggerNextStep({
      executionId,
      stepIndex: 0,
      internalKey: INTERNAL_SYSTEM_KEY,
    });
    
    console.log(`[Chat] Triggered async execution ${executionId} for intent ${intent.type}`);
    
    return executionId;
  } catch (error) {
    console.error("[Chat] Failed to trigger async execution:", error);
    throw error;
  }
}

/**
 * Check if an intent requires saga-style async execution
 * 
 * Saga operations are multi-step, state-modifying operations that benefit from
 * the recursive self-trigger pattern (e.g., booking, reservation, complex workflows)
 */
function requiresSagaExecution(intentType: string): boolean {
  const sagaIntentTypes = [
    "BOOKING",
    "RESERVATION",
    "CREATE_RESERVATION",
    "BOOK_RESTAURANT",
    "RESERVE_RESTAURANT",
    "CREATE_ORDER",
    "PLACE_ORDER",
    "CHECKOUT",
    "PURCHASE",
  ];
  
  return sagaIntentTypes.some(type => intentType.includes(type) || intentType === type);
}

/**
 * Fetch Live Operational State from Redis cache
 * Zero-Latency Context: Pre-inject table availability into system prompt
 * so LLM can "see" state without explicit tool calls
 *
 * Pre-Flight State Injection:
 * - Checks restaurant_state:{id} for table availability
 * - Checks failed_bookings:{restaurantId} for recent failures
 * - If restaurant is "full" or has recent failures, LLM will suggest alternatives
 * - This saves an entire round-trip tool call by preventing invalid plans
 *
 * Hard Constraints:
 * - Restaurants marked as "full" are excluded from planning
 * - Recent failures trigger failover policy evaluation
 * - Delivery alternatives are pre-computed and injected
 */
async function fetchLiveOperationalState(
  messages: any[],
  userLocation?: { lat: number; lng: number },
  intentContext?: {
    intentType?: string;
    partySize?: number;
    requestedTime?: string;
    restaurantId?: string;
  }
): Promise<{
  restaurantStates?: Array<{
    id: string;
    name: string;
    tableAvailability: "available" | "limited" | "full";
    waitlistCount?: number;
    nextAvailableSlot?: string;
    hasRecentFailures?: boolean;
  }>;
  failedBookings?: Array<{
    restaurantId: string;
    restaurantName?: string;
    failureReason: string;
    failedAt: string;
  }>;
  deliveryLoadState?: {
    isHighLoad: boolean;
    avgWaitTimeMinutes: number;
    activeDrivers: number;
    pendingOrders: number;
    recommendedTipBoost: number;
  };
  rawText?: string;
  hardConstraints?: string[];
  failoverSuggestions?: Array<{
    type: string;
    value: unknown;
    confidence: number;
    message?: string;
  }>;
}> {
  try {
    // Extract restaurant mentions from conversation history
    const restaurantMentions = new Set<string>();

    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")
          : "";

      if (!content) continue;

      // Look for restaurant IDs, names, or slugs in the conversation
      // Pattern 1: Direct restaurant ID references
      const idMatches = content.match(/restaurant[:\s]+([a-zA-Z0-9-_]+)/gi);
      if (idMatches) {
        idMatches.forEach((m: string) => {
          const id = m.split(/[:\s]+/)[1];
          if (id) restaurantMentions.add(id);
        });
      }

      // Pattern 2: Common restaurant names (would need NLP in production)
      // For now, look for capitalized multi-word phrases that might be restaurant names
      const nameMatches = content.match(/at\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g);
      if (nameMatches) {
        nameMatches.forEach((m: string) => {
          const name = m.replace(/^at\s+/, "");
          if (name) restaurantMentions.add(name);
        });
      }
    }

    if (restaurantMentions.size === 0) {
      return { rawText: "No specific restaurants mentioned in conversation" };
    }

    console.log(`[LiveOperationalState] Fetching state for restaurants: ${Array.from(restaurantMentions).join(", ")}`);

    // Fetch state from Redis cache (populated by TableStack events)
    const restaurantStates: Array<{
      id: string;
      name: string;
      tableAvailability: "available" | "limited" | "full";
      waitlistCount?: number;
      nextAvailableSlot?: string;
      hasRecentFailures?: boolean;
    }> = [];
    
    const failedBookings: Array<{
      restaurantId: string;
      restaurantName?: string;
      failureReason: string;
      failedAt: string;
    }> = [];

    for (const restaurantRef of restaurantMentions) {
      // Try to fetch from Redis cache
      // Key pattern: restaurant_state:{id|slug}
      const stateKey = `restaurant_state:${restaurantRef}`;
      const cachedState = await redis?.get<any>(stateKey);

      // Also check for failed bookings
      // Key pattern: failed_bookings:{restaurantId} - Redis Set with recent failures
      const failedBookingsKey = `failed_bookings:${restaurantRef}`;
      const recentFailures = await redis?.get<any[]>(failedBookingsKey);
      const hasRecentFailures = recentFailures !== null && recentFailures !== undefined && recentFailures.length > 0;

      if (cachedState) {
        restaurantStates.push({
          id: cachedState.id || restaurantRef,
          name: cachedState.name || restaurantRef,
          tableAvailability: cachedState.tableAvailability || "unknown",
          waitlistCount: cachedState.waitlistCount,
          nextAvailableSlot: cachedState.nextAvailableSlot,
          hasRecentFailures,
        });
      } else {
        // Fallback: Try to fetch from database directly
        try {
          const { db, eq, restaurants: restaurantsTable, restaurantTables } = await import("@repo/database");
          const restaurant = await db.query.restaurants.findFirst({
            where: eq(restaurantsTable.slug, restaurantRef),
          });

          if (restaurant) {
            // Fetch table availability
            const tables = await db.query.restaurantTables.findMany({
              where: eq(restaurantTables.restaurantId, restaurant.id),
            });

            const availableTables = tables.filter((t: any) => t.status === "available").length;
            const totalTables = tables.length;

            restaurantStates.push({
              id: restaurant.id,
              name: restaurant.name,
              tableAvailability: availableTables === 0 ? "full" :
                                 availableTables < totalTables / 2 ? "limited" : "available",
              nextAvailableSlot: availableTables === 0 ? "Unknown - try waitlist" : undefined,
              hasRecentFailures,
            });

            // Also add to failed bookings if present
            if (hasRecentFailures && recentFailures) {
              for (const failure of recentFailures.slice(0, 3)) {
                failedBookings.push({
                  restaurantId: restaurant.id,
                  restaurantName: restaurant.name,
                  failureReason: failure.reason || "Booking failed",
                  failedAt: failure.timestamp || new Date().toISOString(),
                });
              }
            }
          }
        } catch (dbError) {
          console.warn(`[LiveOperationalState] Failed to fetch restaurant ${restaurantRef}:`, dbError);
        }
      }

      // Add failed bookings to result even if restaurant state not found
      if (hasRecentFailures && recentFailures) {
        for (const failure of recentFailures.slice(0, 3)) {
          failedBookings.push({
            restaurantId: restaurantRef,
            failureReason: failure.reason || "Booking failed",
            failedAt: failure.timestamp || new Date().toISOString(),
          });
        }
      }
    }

    // Generate hard constraints for the LLM
    const hardConstraints: string[] = [];
    const failoverSuggestions: Array<{
      type: string;
      value: unknown;
      confidence: number;
      message?: string;
    }> = [];

    // Hard constraint: Block full restaurants from planning
    const fullRestaurants = restaurantStates.filter(r => r.tableAvailability === "full");
    if (fullRestaurants.length > 0) {
      hardConstraints.push(
        `CRITICAL: DO NOT attempt to book at these restaurants (they are full): ${fullRestaurants.map(r => r.name).join(", ")}. ` +
        `Instead, suggest: (1) alternative times, (2) joining waitlist, or (3) delivery options.`
      );
    }

    // Hard constraint: Block restaurants with recent failures
    if (failedBookings && failedBookings.length > 0) {
      const failedRestaurantNames = failedBookings
        .map(f => f.restaurantName || f.restaurantId)
        .filter((name, idx, arr) => arr.indexOf(name) === idx); // Unique
      
      hardConstraints.push(
        `CRITICAL: These restaurants have recent booking failures - DO NOT attempt booking: ${failedRestaurantNames.join(", ")}. ` +
        `Explain the issue to the user and offer alternatives immediately.`
      );
    }

    // Evaluate failover policies if we have failures and intent context
    if ((failedBookings?.length || fullRestaurants.length) && intentContext) {
      try {
        const policyEngine = new FailoverPolicyEngine();
        
        // Map intent type to policy format
        const policyIntentType = intentContext.intentType?.includes("BOOKING") || intentContext.intentType?.includes("RESERVATION")
          ? "BOOKING"
          : intentContext.intentType?.includes("DELIVERY")
            ? "DELIVERY"
            : "BOOKING";

        const evalContext: PolicyEvaluationContext = {
          intent_type: policyIntentType,
          failure_reason: fullRestaurants.length > 0 ? "RESTAURANT_FULL" : "VALIDATION_FAILED",
          confidence: 0.8,
          party_size: intentContext.partySize,
          requested_time: intentContext.requestedTime,
          restaurant_tags: intentContext.restaurantId ? [intentContext.restaurantId] : undefined,
        };

        const result = policyEngine.evaluate(evalContext);
        
        if (result.matched && result.recommended_action) {
          failoverSuggestions.push({
            type: result.recommended_action.type,
            value: result.recommended_action.parameters,
            confidence: result.confidence,
            message: result.recommended_action.message_template,
          });

          // Add specific suggestions based on action type
          if (result.recommended_action.type === "SUGGEST_ALTERNATIVE_TIME" && intentContext.requestedTime) {
            const offsets = (result.recommended_action.parameters?.time_offset_minutes as number[]) || [-30, 30];
            const baseMinutes = parseInt(intentContext.requestedTime.replace(":", "")) as number;
            const [hours, mins] = intentContext.requestedTime.split(":").map(Number);
            const baseTotalMins = hours * 60 + mins;
            
            offsets.slice(0, 2).forEach((offset, idx) => {
              const newTotal = baseTotalMins + offset;
              if (newTotal >= 0 && newTotal < 24 * 60) {
                const newHours = Math.floor(newTotal / 60);
                const newMins = newTotal % 60;
                failoverSuggestions.push({
                  type: "alternative_time",
                  value: `${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")}`,
                  confidence: 0.9 - (idx * 0.1),
                  message: `How about ${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")} instead?`,
                });
              }
            });
          }

          if (result.recommended_action.type === "TRIGGER_DELIVERY") {
            failoverSuggestions.push({
              type: "delivery_alternative",
              value: {
                estimated_time: "30-45 minutes",
                min_order: result.recommended_action.parameters?.min_order_amount as number || 1500,
              },
              confidence: 0.85,
              message: "Delivery is available from this restaurant in 30-45 minutes.",
            });
          }

          if (result.recommended_action.type === "TRIGGER_WAITLIST") {
            failoverSuggestions.push({
              type: "waitlist_alternative",
              value: {
                estimated_wait: "15-30 minutes",
                notification_method: "sms",
              },
              confidence: 0.75,
              message: "You can join the waitlist - current wait is approximately 15-30 minutes.",
            });
          }
        }
      } catch (policyError) {
        console.warn("[FailoverPolicy] Failed to evaluate policies:", policyError);
        // Continue without failover suggestions
      }
    }

    // Check delivery load state for tip boost recommendations
    let deliveryLoadState: {
      isHighLoad: boolean;
      avgWaitTimeMinutes: number;
      activeDrivers: number;
      pendingOrders: number;
      recommendedTipBoost: number;
    } | undefined;

    try {
      // Fetch pending orders count and active drivers from database
      const { db, sql, orders, drivers } = await import("@repo/database");

      const [pendingCountResult, activeDriversResult] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) as count FROM orders WHERE status = 'pending' AND driver_id IS NULL`),
        db.execute(sql`SELECT COUNT(*) as count FROM drivers WHERE is_active = true`),
      ]);

      const pendingOrders = parseInt((pendingCountResult.rows[0] as any)?.count || "0");
      const activeDrivers = parseInt((activeDriversResult.rows[0] as any)?.count || "0");

      // Calculate load ratio and determine if high load
      const driverRatio = activeDrivers > 0 ? pendingOrders / activeDrivers : 999;
      const isHighLoad = driverRatio > 2 || pendingOrders > 10;

      // Calculate recommended tip boost based on load
      let recommendedTipBoost = 0;
      if (isHighLoad) {
        if (driverRatio > 5 || pendingOrders > 20) {
          recommendedTipBoost = 5; // High demand - suggest $5 boost
        } else if (driverRatio > 3 || pendingOrders > 15) {
          recommendedTipBoost = 3; // Medium demand - suggest $3 boost
        } else {
          recommendedTipBoost = 2; // Low demand - suggest $2 boost
        }
      }

      // Estimate wait time based on load
      const avgWaitTimeMinutes = isHighLoad ? Math.round(15 + (driverRatio * 5)) : 10;

      deliveryLoadState = {
        isHighLoad,
        avgWaitTimeMinutes,
        activeDrivers,
        pendingOrders,
        recommendedTipBoost,
      };

      // Add tip boost suggestion if high load
      if (isHighLoad && intentContext?.intentType?.includes("DELIVERY")) {
        failoverSuggestions.push({
          type: "tip_boost_recommendation",
          value: {
            current_load: "high",
            pending_orders: pendingOrders,
            active_drivers: activeDrivers,
            recommended_boost: recommendedTipBoost,
          },
          confidence: 0.85,
          message: `Drivers are in high demand right now. Increasing your tip by $${recommendedTipBoost} may attract a driver faster and reduce your wait time.`,
        });
      }
    } catch (error) {
      console.warn("[DeliveryLoadState] Failed to fetch delivery load state:", error);
      // Continue without delivery load state
    }

    return {
      restaurantStates,
      failedBookings: failedBookings?.length ? failedBookings : undefined,
      deliveryLoadState,
      hardConstraints: hardConstraints.length > 0 ? hardConstraints : undefined,
      failoverSuggestions: failoverSuggestions.length > 0 ? failoverSuggestions : undefined,
    };
  } catch (error) {
    console.error("[LiveOperationalState] Failed to fetch operational state:", error);
    return { rawText: "Unable to fetch live restaurant states" };
  }
}

/**
 * Dynamically fetches tools from all registered MCP servers.
 * Uses centralized McpToolRegistry schemas for validation.
 */
async function getTools(auditLogId: string, userLocation?: { lat: number, lng: number }) {
  const { manager } = await getMcpClients();
  const tools: Record<string, any> = {};

  // Helper to get schema from McpToolRegistry
  const getSchemaForTool = (toolName: string): z.ZodType<any> | undefined => {
    // Flatten the TOOLS registry to find matching schema
    const allTools = Object.values(TOOLS).flatMap(service => Object.values(service));
    const toolDef = allTools.find(t => (t as any).name === toolName);
    return (toolDef as any)?.schema;
  };

  // Get discovered tools from the dynamic manager
  const toolRegistry = manager.getToolRegistry();
  
  for (const [toolName, toolDef] of toolRegistry.entries()) {
    try {
      // Use schema from registry if available, fallback to generic
      const registrySchema = getSchemaForTool(toolName);

      tools[toolName] = tool({
        description: (toolDef as any).description || toolDef.name,
        inputSchema: registrySchema || z.record(z.any()),
        execute: async (params) => {
          console.log(`Executing MCP tool ${toolName}`, params);

          // Use the manager's executeTool method with parameter aliasing
          const result = await manager.executeTool(toolName, params);

          if (result.success) {
            return result.output;
          } else {
            throw new Error(result.error || 'Tool execution failed');
          }
        },
      });
    } catch (error) {
      console.error(`Error registering tool ${toolName}:`, error);
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
    const clerkId = req.headers.get("x-clerk-id") || undefined;
    const userId = clerkId || userIp; // Prefer clerkId, fallback to IP for anonymous
    const userPrefsKey = `prefs:${userId}`;
    let userPreferences = null;
    let recentLogs: any[] = [];

    const { createAuditLog, updateAuditLog, getUserAuditLogs } = await import("@/lib/audit");
    const { executeToolWithContext, getPlanWithAvoidance, getProvider } = await import("@/app/actions");

    if (redis) {
      try {
        [userPreferences, recentLogs] = await Promise.all([
          getUserPreferences(userId),
          getUserAuditLogs(userId, 10)
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

      // Contextual Memory: Retrieve last interaction context from Postgres
      // This enables pronoun resolution ("it", "there", "that restaurant")
      const lastInteractionContext = await (async () => {
        if (clerkId) {
          try {
            const { getLastInteractionContextByClerkId } = await import("@/lib/intent");
            return await getLastInteractionContextByClerkId(clerkId);
          } catch (err) {
            console.warn("Failed to retrieve last interaction context by clerkId:", err);
          }
        } else if (userIp !== "anonymous") {
          // Fallback to email-based lookup for anonymous users (legacy)
          try {
            const { getLastInteractionContext } = await import("@/lib/intent");
            return await getLastInteractionContext(userIp);
          } catch (err) {
            console.warn("Failed to retrieve last interaction context:", err);
          }
        }
        return null;
      })();

      const inferenceResult = await inferIntent(userText, avoidTools, [], lastInteractionContext || undefined);
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

    // ========================================================================
    // SAGA PATTERN: Immediate Handoff for Multi-Step Operations
    // ========================================================================
    // If this is a complex multi-step operation, trigger async execution
    // and return immediately to avoid Vercel 10s timeout
    if (requiresSagaExecution(intent.type)) {
      try {
        // Trigger async execution via QStash
        const executionId = await triggerAsyncExecution(
          intent,
          {
            userId: userId as string | undefined,
            clerkId: clerkId || undefined,
            userEmail: undefined,
          },
          auditLog.id
        );

        // Return immediately to client (<500ms response time)
        return new Response(JSON.stringify({
          success: true,
          executionId,
          message: "I've started working on that. Track progress in real-time.",
          status: "STARTED",
          intentType: intent.type,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[Chat] Failed to trigger async execution:", error);
        // Fallback: If QStash fails in prod, error out - do NOT fallback to sync
        return new Response(
          JSON.stringify({
            error: "System busy, please try again",
            code: "SAGA_TRIGGER_FAILED",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Zero-Latency Context: Fetch live operational state BEFORE calling LLM
    // This allows the LLM to "see" table availability without explicit tool calls
    // Pre-Flight State Injection with Hard Constraints and Failover Policy
    const liveOperationalState = await fetchLiveOperationalState(coreMessages, userLocation || undefined, {
      intentType: intent.type,
      partySize: intent.parameters?.partySize as number | undefined,
      requestedTime: intent.parameters?.time as string | undefined,
      restaurantId: intent.parameters?.restaurantId as string | undefined,
    });

    // Build live state context with failed bookings awareness
    const liveStateContextParts: string[] = [];

    if (liveOperationalState.restaurantStates) {
      liveStateContextParts.push(
        `\n### LIVE RESTAURANT STATE (Real-time from Redis/DB):\n${liveOperationalState.restaurantStates
          .map(r => `- ${r.name}: ${r.tableAvailability.toUpperCase()}${r.waitlistCount ? ` (${r.waitlistCount} on waitlist)` : ""}${r.nextAvailableSlot ? ` - Next: ${r.nextAvailableSlot}` : ""}${r.hasRecentFailures ? " ⚠️ RECENT FAILURES" : ""}`)
          .join("\n")}\n\n**IMPORTANT**: Use this live state to avoid suggesting restaurants that are full. If a restaurant shows "full", suggest alternatives or recommend joining the waitlist.`
      );
    }

    if (liveOperationalState.failedBookings && liveOperationalState.failedBookings.length > 0) {
      liveStateContextParts.push(
        `\n### ⚠️ RECENT BOOKING FAILURES (Avoid These):\n${liveOperationalState.failedBookings
          .map(f => `- ${f.restaurantName || f.restaurantId}: ${f.failureReason} (at ${new Date(f.failedAt).toLocaleTimeString()})`)
          .join("\n")}\n\n**CRITICAL**: These restaurants have recent booking failures. DO NOT attempt to book these unless the user explicitly insists. Instead, suggest alternative restaurants or explain the issue to the user.`
      );
    }

    // HARD CONSTRAINTS - Block invalid plans before generation
    if (liveOperationalState.hardConstraints && liveOperationalState.hardConstraints.length > 0) {
      liveStateContextParts.push(
        `\n### 🚫 HARD CONSTRAINTS (MUST FOLLOW):\n${liveOperationalState.hardConstraints
          .map(c => `- ${c}`)
          .join("\n")}\n\n**WARNING**: Violating these constraints will result in immediate plan rejection.`
      );
    }

    // FAILOVER SUGGESTIONS - Pre-computed alternatives
    if (liveOperationalState.failoverSuggestions && liveOperationalState.failoverSuggestions.length > 0) {
      liveStateContextParts.push(
        `\n### 💡 RECOMMENDED ALTERNATIVES (Pre-computed):\n${liveOperationalState.failoverSuggestions
          .map(s => `- [${s.type.toUpperCase()}] ${s.message || JSON.stringify(s.value)} (Confidence: ${(s.confidence * 100).toFixed(0)}%)`)
          .join("\n")}\n\n**TIP**: These alternatives have been pre-validated and are ready to offer.`
      );
    }

    // DELIVERY LOAD STATE - Real-time demand/supply for tip recommendations
    if (liveOperationalState.deliveryLoadState) {
      const { isHighLoad, avgWaitTimeMinutes, activeDrivers, pendingOrders, recommendedTipBoost } = liveOperationalState.deliveryLoadState;
      liveStateContextParts.push(
        `\n### 🚗 DELIVERY LOAD STATE (Real-time):\n- Active Drivers: ${activeDrivers}\n- Pending Orders: ${pendingOrders}\n- Load Status: ${isHighLoad ? "HIGH DEMAND" : "Normal"}\n- Avg Wait Time: ${avgWaitTimeMinutes} minutes\n\n**TIP BOOST RECOMMENDATION**: ${isHighLoad ? `Suggest increasing tip by $${recommendedTipBoost} to prioritize this order. Higher tips attract drivers faster during high demand.` : "Current tip levels are adequate for normal demand."}`
      );
    }

    const liveStateContext = liveStateContextParts.length > 0
      ? liveStateContextParts.join("\n\n")
      : `\n### LIVE STATE: ${liveOperationalState.rawText || "No live state available"}\n`;

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

            // SAGA DETECTION - Check if this tool requires async execution
            // For saga-type operations (booking, reservation, etc.), trigger async execution
            // instead of executing inline to avoid Vercel timeout
            if (requiresSagaExecution(localTool.name) || requiresSagaExecution(intent.type)) {
              try {
                console.log(`[Chat] Detected saga operation (${localTool.name}), triggering async execution`);
                
                // Create a synthetic intent for this specific tool execution
                const sagaIntent = {
                  id: crypto.randomUUID(),
                  type: localTool.name.toUpperCase(),
                  confidence: 0.9,
                  parameters: enrichedParams,
                  rawText: userText,
                  metadata: { version: "1.0.0", timestamp: new Date().toISOString(), source: "chat_saga" }
                };
                
                // Trigger async execution via QStash
                const executionId = await triggerAsyncExecution(sagaIntent, {
                  userId: userId as string | undefined,
                  clerkId: clerkId || undefined,
                  userEmail: undefined,
                }, auditLog.id);
                
                // Return immediately with execution ID for tracking
                return {
                  success: true,
                  executionId,
                  message: `Started ${localTool.name} execution. Track progress via execution ID: ${executionId}`,
                  status: "STARTED",
                };
              } catch (error) {
                console.error(`[Chat] Failed to trigger async execution for ${localTool.name}:`, error);
                return {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }

            // Normal inline execution for non-saga operations
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
    ${liveStateContext}
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

          // Contextual Memory: Save the interaction context for future pronoun resolution
          if (userId) {
            const { saveInteractionContextByClerkId, saveInteractionContext } = await import("@/lib/intent");
            if (clerkId) {
              await saveInteractionContextByClerkId(clerkId, intent, auditLog.id);
            } else if (userIp !== "anonymous") {
              await saveInteractionContext(userIp, intent, auditLog.id);
            }
          }
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
