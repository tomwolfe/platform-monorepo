import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, convertToModelMessages, generateObject } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  getToolCapabilitiesPrompt,
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
} from "@repo/mcp-protocol";
import { getNervousSystemObserver } from "@/lib/listeners/nervous-system-observer";
import { saveExecutionState, loadExecutionState } from "@/lib/engine/memory";
import { createInitialState, setIntent, setPlan } from "@/lib/engine/state-machine";
import { parseIntent as engineParseIntent } from "@/lib/engine/intent";
import { generatePlan as engineGeneratePlan } from "@/lib/engine/planner";
import { getRegistryManager } from "@/lib/engine/registry";
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";
import { promptInjectionMiddleware } from "@/lib/middleware/prompt-injection";
import { rateLimitMiddleware, createRateLimitMiddleware } from "@/lib/middleware/rate-limiter";
import { AppConfig } from "@repo/shared";
import { fetchLiveOperationalState } from "@/lib/engine/live-state";

// Internal system key for QStash-triggered requests - uses strict getter
const INTERNAL_SYSTEM_KEY = AppConfig.getInternalSystemKey();

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
    // CRITICAL: Pass trace context for distributed tracing
    await QStashService.triggerNextStep({
      executionId,
      stepIndex: 0,
      internalKey: INTERNAL_SYSTEM_KEY,
      traceId: executionId, // Use executionId as initial traceId
      correlationId: executionId,
    });

    console.log(`[Chat] Triggered async execution ${executionId} for intent ${intent.type} [trace: ${executionId}]`);

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
 *
 * STRICT SAGA ENFORCEMENT: All state-modifying operations MUST use async execution
 * to avoid Vercel 10s timeout and ensure proper compensation handling.
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
    // Delivery and logistics
    "DISPATCH",
    "DELIVERY",
    "CREATE_DELIVERY",
    // Communication (state-modifying)
    "SEND_COMM",
    "SEND_EMAIL",
    "SEND_SMS",
    // Calendar (state-modifying)
    "ADD_CALENDAR_EVENT",
    "CREATE_EVENT",
    // Payment (state-modifying)
    "PAYMENT",
    "PROCESS_PAYMENT",
    "REFUND",
    // Ride/mobility
    "REQUEST_RIDE",
    "MOBILITY",
  ];

  return sagaIntentTypes.some(type => intentType.includes(type) || intentType === type);
}

/**
 * Dynamically fetches tools from all registered MCP servers.
 * Uses centralized McpToolRegistry schemas for validation.
 * All tool execution is routed through DynamicMcpClientManager.executeTool()
 * for consistent parameter aliasing and server routing.
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
          // This handles routing between remote MCP tools and local tool executions
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
    
    // RATE LIMITING: User-level rate limiting to prevent quota drain
    const rateLimitResult = await rateLimitMiddleware(userId, "chat");
    
    if (!rateLimitResult.allowed) {
      console.warn(`[RateLimiter] Rate limit exceeded for user ${userId}`);
      
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          message: "Too many requests. Please wait a moment before trying again.",
          retryAfter: rateLimitResult.result.retryAfter,
          limit: rateLimitResult.result.headers["X-RateLimit-Limit"],
          remaining: rateLimitResult.result.headers["X-RateLimit-Remaining"],
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            ...rateLimitResult.result.headers,
          },
        }
      );
    }

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
    
    // SECURITY: Prompt Injection Detection
    // Scan user input for prompt injection attacks before processing
    const securityCheck = await promptInjectionMiddleware(userText, userId, {
      enableHeuristics: true,
      enableSemanticAnalysis: true,
      enableEncodingDetection: true,
      enableAuditLog: true,
    });

    if (!securityCheck.allowed) {
      console.warn(`[Security] Prompt injection detected for user ${userId}:`, securityCheck.detectionResult);

      // Return appropriate error based on risk level
      const statusCode = securityCheck.detectionResult.riskLevel === "critical" ? 403 : 400;
      return new Response(
        JSON.stringify({
          error: "Input blocked for security reasons",
          message: securityCheck.detectionResult.recommendedAction === "block"
            ? "Your input contains patterns that may attempt to manipulate the AI system. Please rephrase your request."
            : "Your input requires review. Please rephrase or contact support if this persists.",
          riskLevel: securityCheck.detectionResult.riskLevel,
          ...(process.env.NODE_ENV === "development" && {
            debug: {
              attackTypes: securityCheck.detectionResult.attackTypes,
              explanation: securityCheck.detectionResult.explanation,
            },
          }),
        }),
        {
          status: statusCode,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

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

      const inferenceResult = await inferIntent(
        userText,
        avoidTools,
        [],
        lastInteractionContext || undefined,
        clerkId || undefined // Pass clerkId for retrieving last 3 successful intents from audit logs
      );
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
    // All tool execution is routed through DynamicMcpClientManager.executeTool()
    const allTools = await getTools(auditLog.id, userLocation || undefined);

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
  } catch (error) {
    console.error("Error in chat route:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
