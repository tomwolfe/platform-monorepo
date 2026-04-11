"use server";

import { getUserAuditLogs } from "@/lib/audit";
import { AppConfig, withServerActionHandler, Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine-actions" });

/**
 * Get recent failed tools to avoid in planning
 * This implements the "avoidance pattern" - learning from past failures
 */
export const getPlanWithAvoidance = withServerActionHandler(
  async (intent: string, userId: string) => {
    if (!userId || userId === "anonymous") {
      logger.warn("getPlanWithAvoidance called with weak user context", {
        userId: userId || "missing",
        intentPreview: intent.slice(0, 50),
      });
    }
    // Phase 2: Memory & Guardrails - Fetch last 5 logs and extract failed tools
    const recentLogs = await getUserAuditLogs(userId || "anonymous", 5);
    const avoidTools: string[] = [];

    for (const log of recentLogs) {
      if (log.steps) {
        for (const step of log.steps) {
          if (step.status === "failed") {
            avoidTools.push(step.tool_name);
          }
        }
      }
    }

    // We'll pass this to intent inference/planning logic
    return {
      avoidTools: Array.from(new Set(avoidTools)),
    };
  },
  { errorCode: "GET_PLAN_WITH_AVOIDANCE_FAILED" },
);

/**
 * Multi-Provider LLM Routing
 * Routes ANALYSIS intents to OpenAI, all others to GLM-4
 * Supports optional fallback provider for resilience.
 */
export const getProvider = withServerActionHandler(
  async (intentType: string, options?: { useFallback?: boolean }) => {
    const { useFallback = false } = options ?? {};

    if (useFallback) {
      const fallbackModel = process.env.LLM_FALLBACK_MODEL || "gpt-4o-mini";
      return {
        provider: "openai-fallback",
        apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
        model: fallbackModel,
        baseUrl: "https://api.openai.com/v1",
      };
    }

    // Phase 3: Multi-Provider Support
    // Use GLM-4 for 'search' and 'booking' intents, but route 'analysis' intents to OpenAI.
    if (intentType === "ANALYSIS") {
      return {
        provider: "openai",
        apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
        model: "gpt-4o", // Default to gpt-4o for analysis
        baseUrl: "https://api.openai.com/v1",
      };
    }

    return {
      provider: "glm",
      apiKey: process.env.LLM_API_KEY,
      model: AppConfig.getLlmModel(),
      baseUrl: AppConfig.getLlmBaseUrl(),
    };
  },
  { errorCode: "GET_PROVIDER_FAILED" },
);
