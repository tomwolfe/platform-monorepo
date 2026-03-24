/**
 * Stub implementations for interaction context tracking.
 * These are placeholder functions for future intent/context persistence features.
 */

export async function getLastInteractionContextByClerkId(clerkId: string) {
  return null; // Stub - feature not implemented
}

export async function getLastInteractionContext(userIp: string) {
  return null; // Stub - feature not implemented
}

export async function saveInteractionContextByClerkId(
  clerkId: string,
  intent: any,
  auditLogId: string
) {
  // Stub - no-op
}

export async function saveInteractionContext(
  userIp: string,
  intent: any,
  auditLogId: string
) {
  // Stub - no-op
}
