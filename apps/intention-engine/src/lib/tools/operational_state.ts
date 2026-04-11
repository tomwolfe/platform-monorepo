import { z } from "zod";
import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
import { ToolExecutionContext } from "../engine/tools/registry";
import { ToolDefinitionMetadata } from "./types";
import { GetLiveOperationalStateSchema as LiveStateSchema } from "@repo/mcp-protocol";

const logger = new Logger({ serviceName: "tool-operational-state" });

export type LiveStateParams = z.infer<typeof LiveStateSchema>;

export const liveStateReturnSchema = {
  live_data: "object",
  message: "string",
};

// Lazy redis client for fallback when context.services.redis is not available
let _cachedRedis: ReturnType<typeof getRedisClient> | null = null;
function getFallbackRedis() {
  if (!_cachedRedis) {
    _cachedRedis = getRedisClient(ServiceNamespace.IE);
  }
  return _cachedRedis;
}

/**
 * Fetches the live operational state of a restaurant (e.g., table statuses).
 */
export async function get_live_operational_state(
  params: LiveStateParams,
  context?: ToolExecutionContext,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const validated = LiveStateSchema.safeParse(params);
  if (!validated.success) {
    return {
      success: false,
      error: "Invalid parameters: " + JSON.stringify(validated.error.format()),
    };
  }

  const { restaurant_id } = validated.data;
  const key = `state:${restaurant_id}:tables`;

  try {
    // Use injected Redis from context if available, otherwise fallback to singleton
    const redis = context?.services?.redis || getFallbackRedis();
    const liveData = await redis.hgetall(key);

    if (!liveData || Object.keys(liveData).length === 0) {
      return {
        success: true,
        result: {
          live_data: {},
          message: "No live operational data available for this restaurant.",
        },
      };
    }

    // Parse values back from JSON strings
    const parsedData: Record<string, unknown> = {};
    for (const [tableId, value] of Object.entries(liveData)) {
      parsedData[tableId] =
        typeof value === "string" ? JSON.parse(value) : value;
    }

    return {
      success: true,
      result: {
        live_data: parsedData,
        message: "Live operational state retrieved successfully.",
      },
    };
  } catch (error: unknown) {
    logger.error("Failed to get live operational state", {
      restaurantId: validated.data?.restaurant_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const getLiveOperationalStateToolDefinition: ToolDefinitionMetadata = {
  name: "get_live_operational_state",
  version: "1.0.0",
  description:
    "Authorized to access real-time operational data for a restaurant. Provides live status updates on tables (vacant, occupied, dirty) to assist with precise booking and floor management.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_id: {
        type: "string",
        description: "The unique identifier for the restaurant.",
      },
    },
    required: ["restaurant_id"],
  },
  return_schema: liveStateReturnSchema,
  timeout_ms: 10000,
  requires_confirmation: false,
  category: "data",
  rate_limits: {
    requests_per_minute: 30,
    requests_per_hour: 500,
  },
};
