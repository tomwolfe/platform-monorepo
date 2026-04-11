/**
 * Context Persistence - Saves last interaction context for conversational continuity
 * Objective 5: Shared Database Constraints
 */

import { getDb, users, eq } from "@repo/database";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "context-persistence" });

export interface InteractionContext {
  intentType: string;
  rawText: string;
  parameters: Record<string, unknown>;
  timestamp: string;
  executionId: string;
}

/**
 * Save the last successfully inferred intent to the user's profile.
 * Enables "contextual continuity" - e.g., "actually, make it 2 people"
 * refers to the pizza place found in the previous turn.
 */
export async function saveUserInteractionContext(
  userId: string,
  context: InteractionContext,
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(users)
      .set({
        lastInteractionContext: context,
        updatedAt: new Date(),
      })
      .where(eq(users.clerkId, userId));

    logger.info("Saved context for user", {
      userId,
      intentType: context.intentType,
    });
  } catch (error) {
    logger.error({
      message: `[Context Persistence] Failed to save context for user ${userId}`,
      error: error instanceof Error ? error.message : String(error),
      context: { userId, intentType: context.intentType },
    });
    // Non-critical operation - don't throw
  }
}

/**
 * Load the last interaction context for a user.
 * Returns null if no context exists.
 */
export async function loadUserInteractionContext(
  clerkId: string,
): Promise<InteractionContext | null> {
  try {
    const user = await getDb().query.users.findFirst({
      where: eq(users.clerkId, clerkId),
    });

    return user?.lastInteractionContext || null;
  } catch (error) {
    logger.error({
      message: `[Context Persistence] Failed to load context for user ${clerkId}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
