import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, convertToModelMessages } from "ai";
import { z } from "zod";
import { getToolCapabilitiesPrompt } from "@/lib/tools";
import { getUserPreferences } from "@/lib/preferences";
import { getRedisClient, ServiceNamespace, AppConfig } from "@repo/shared";
import { getMcpClients } from "@/lib/mcp-client";
import { TOOLS } from "@repo/mcp-protocol";
import { rateLimitMiddleware } from "@/lib/middleware/rate-limiter";
import { fetchLiveOperationalState } from "@/lib/engine/live-state";
import { createChatOrchestrator, type ChatOrchestrationResult } from "@/lib/engine/chat-orchestrator";

// Use AppConfig directly - no local wrapper needed
const INTERNAL_SYSTEM_KEY = AppConfig.getInternalSystemKey();
const LLM_API_KEY = AppConfig.getLlmApiKey();
const LLM_BASE_URL = AppConfig.getLlmBaseUrl();

export const runtime = "nodejs";
export const maxDuration = 30;

const redis = getRedisClient(ServiceNamespace.IE);

const openai = createOpenAI({
  apiKey: LLM_API_KEY,
  baseURL: LLM_BASE_URL,
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

/**
 * Build live state context string from operational state result
 */
function buildLiveStateContext(liveOperationalState: ReturnType<typeof fetchLiveOperationalState> extends Promise<infer T> ? T : never): string {
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

  return liveStateContextParts.length > 0
    ? liveStateContextParts.join("\n\n")
    : `\n### LIVE STATE: ${liveOperationalState.rawText || "No live state available"}\n`;
}

/**
 * Extract user text from core messages
 */
function extractUserText(coreMessages: any[]): string {
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
  return userText;
}

/**
 * Get relevant failure warnings from recent audit logs
 */
function getRelevantFailures(text: string, logs: any[]): string[] {
  const keywords = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const failures: string[] = [];
  for (const log of logs) {
    if (log.steps) {
      for (const step of log.steps) {
        if (step.status === "failed") {
          const inputStr = JSON.stringify(step.input).toLowerCase();
          const hasOverlap = keywords.some(k => inputStr.includes(k));

          if (hasOverlap) {
            const specificWarning = `Previous attempt at ${step.tool_name} with parameters ${JSON.stringify(step.input)} failed with error: "${step.error}".`;
            failures.push(specificWarning);
          }
        }
      }
    }
  }
  return Array.from(new Set(failures)).slice(0, 3);
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

    let recentLogs: any[] = [];
    const { createAuditLog, updateAuditLog, getUserAuditLogs } = await import("@/lib/audit");
    const { getPlanWithAvoidance, getProvider } = await import("@/app/actions");

    if (redis) {
      try {
        [, recentLogs] = await Promise.all([
          getUserPreferences(userId),
          getUserAuditLogs(userId, 10)
        ]);
      } catch (err) {
        console.warn("Failed to retrieve user data from Redis:", err);
      }
    }

    const coreMessages = await convertToModelMessages(messages);
    const userText = extractUserText(coreMessages);

    // Initialize Chat Orchestrator Service
    const orchestrator = createChatOrchestrator(INTERNAL_SYSTEM_KEY, {
      userId,
      clerkId,
      userIp,
    });

    // Get contextual memory for intent inference
    const lastInteractionContext = await (async () => {
      if (clerkId) {
        try {
          const { getLastInteractionContextByClerkId } = await import("@/lib/intent");
          return await getLastInteractionContextByClerkId(clerkId);
        } catch (err) {
          console.warn("Failed to retrieve last interaction context by clerkId:", err);
        }
      } else if (userIp !== "anonymous") {
        try {
          const { getLastInteractionContext } = await import("@/lib/intent");
          return await getLastInteractionContext(userIp);
        } catch (err) {
          console.warn("Failed to retrieve last interaction context:", err);
        }
      }
      return null;
    })();

    // Orchestrate the chat request (security, intent inference, live state, async execution)
    const { avoidTools } = await getPlanWithAvoidance(userText, userIp);
    const history = recentLogs
      .filter(log => log.final_outcome && !log.steps?.some(s => s.status === "failed"))
      .map(log => ({
        intentType: log.intent.type,
        rawText: log.intent.rawText,
        parameters: log.intent.parameters || {},
        timestamp: log.timestamp,
      }));

    let orchestrationResult: ChatOrchestrationResult;

    try {
      orchestrationResult = await orchestrator.orchestrate(
        {
          messages,
          userLocation: userLocation || undefined,
          userContext: { userId, clerkId, userIp, userEmail: undefined },
        },
        userText,
        coreMessages,
        avoidTools,
        history,
        lastInteractionContext
      );
    } catch (securityError: any) {
      // Handle security check failures (prompt injection)
      if (securityError.message.includes("Input blocked for security reasons")) {
        const detectionResult = securityError.message.split(": ")[1] || "Security check failed";
        return new Response(
          JSON.stringify({
            error: "Input blocked for security reasons",
            message: "Your input contains patterns that may attempt to manipulate the AI system. Please rephrase your request.",
            riskLevel: "high",
            ...(process.env.NODE_ENV === "development" && {
              debug: {
                attackTypes: ["PROMPT_INJECTION"],
                explanation: detectionResult,
              },
            }),
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      throw securityError;
    }

    const { intent, auditLogId, executionId, requiresAsyncExecution, liveOperationalState } = orchestrationResult;

    // Handle saga-style async execution
    if (requiresAsyncExecution && executionId) {
      return new Response(JSON.stringify({
        success: true,
        executionId,
        message: "I've started working on that. Track progress in real-time.",
        status: "STARTED",
        intentType: intent.type,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Build failure warnings from recent logs
    const relevantFailures = getRelevantFailures(userText, recentLogs);
    const failureWarnings = relevantFailures.length > 0
      ? `\n### DO NOT REPEAT THESE MISTAKES:\n${relevantFailures.map(f => `- ${f}`).join('\n')}`
      : "";

    // Build live state context (for non-saga requests)
    const liveStateContext = liveOperationalState
      ? buildLiveStateContext(liveOperationalState)
      : "\n### LIVE STATE: No live state available\n";

    // Fetch dynamic tools from MCP servers
    const allTools = await getTools(auditLogId, userLocation || undefined);

    const locationContext = userLocation
      ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}.`
      : "The user's location is unknown.";

    const memoryContext = recentLogs.length > 0
      ? `Recent interaction history:\n${recentLogs.map(l => `- Intent: ${l.intent}, Outcome: ${l.final_outcome || 'N/A'}`).join('\n')}`
      : "";

    const toolCapabilitiesPrompt = getToolCapabilitiesPrompt();

    const systemPrompt = `You are an Intention Engine.
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
          await updateAuditLog(auditLogId, {
            final_outcome: event.text,
            inferenceLatencies: {
              total: totalLatency,
            }
          });

          // Contextual Memory: Save the interaction context for future pronoun resolution
          if (userId) {
            const { saveInteractionContextByClerkId, saveInteractionContext } = await import("@/lib/intent");
            if (clerkId) {
              await saveInteractionContextByClerkId(clerkId, intent, auditLogId);
            } else if (userIp !== "anonymous") {
              await saveInteractionContext(userIp, intent, auditLogId);
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
