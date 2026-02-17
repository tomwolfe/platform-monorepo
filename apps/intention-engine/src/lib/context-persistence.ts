/**
 * Context Persistence - Saves last interaction context for conversational continuity
 * Objective 5: Shared Database Constraints
 */

import { db, users, eq } from "@repo/database";

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
  context: InteractionContext
): Promise<void> {
  try {
    await db
      .update(users)
      .set({
        lastInteractionContext: context,
        updatedAt: new Date(),
      })
      .where(eq(users.clerkId, userId));
    
    console.log(`[Context Persistence] Saved context for user ${userId}: ${context.intentType}`);
  } catch (error) {
    console.error('[Context Persistence] Failed to save context:', error);
    // Non-critical operation - don't throw
  }
}

/**
 * Load the last interaction context for a user.
 * Returns null if no context exists.
 */
export async function loadUserInteractionContext(
  clerkId: string
): Promise<InteractionContext | null> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, clerkId),
    });
    
    return user?.lastInteractionContext || null;
  } catch (error) {
    console.error('[Context Persistence] Failed to load context:', error);
    return null;
  }
}
