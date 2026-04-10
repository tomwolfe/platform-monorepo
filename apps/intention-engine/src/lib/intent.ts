/**
 * Interaction context tracking for conversational continuity.
 * These functions wire to the actual implementations in context-persistence.ts
 * enabling "contextual continuity" - e.g., "actually, make it 2 people"
 * refers to the pizza place found in the previous turn.
 */

import {
  loadUserInteractionContext,
  saveUserInteractionContext,
  type InteractionContext,
} from "./context-persistence";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine-intent" });

export async function getLastInteractionContextByClerkId(clerkId: string) {
  return await loadUserInteractionContext(clerkId);
}

export async function getLastInteractionContext(userIp: string) {
  // Note: IP-based lookup not implemented - use clerkId instead
  logger.warn(
    "getLastInteractionContext called with IP, but only clerkId is supported",
    { userIp },
  );
  return null;
}

interface ParsedIntent {
  type: string;
  rawText: string;
  parameters: Record<string, unknown>;
}

export async function saveInteractionContextByClerkId(
  clerkId: string,
  intent: ParsedIntent,
  auditLogId: string,
) {
  const context: InteractionContext = {
    intentType: intent.type,
    rawText: intent.rawText,
    parameters: intent.parameters,
    timestamp: new Date().toISOString(),
    executionId: auditLogId,
  };

  await saveUserInteractionContext(clerkId, context);
}

export async function saveInteractionContext(
  userIp: string,
  intent: ParsedIntent,
  auditLogId: string,
) {
  // Note: IP-based persistence not implemented - use clerkId instead
  logger.warn(
    "saveInteractionContext called with IP, but only clerkId is supported",
    { userIp, auditLogId },
  );
  // Non-critical operation - don't throw
}
