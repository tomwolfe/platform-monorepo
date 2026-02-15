import { redis } from "./redis-client";
import type { Plan, Intent } from "./schema";
import { env } from "./config";
import type { AuditLog } from "./types";

const AUDIT_LOG_PREFIX = "audit_log:";
const USER_LOGS_PREFIX = "user_logs:";

/**
 * Calculates a SHA-256 hash of the intent's core content for cryptographic linking.
 */
export async function calculateIntentHash(intent: Omit<Intent, "hash">): Promise<string> {
  const content = JSON.stringify({
    type: intent.type,
    parameters: intent.parameters,
    rawText: intent.rawText,
    parent_intent_id: intent.parent_intent_id
  });
  
  const msgUint8 = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createAuditLog(
  intent: Intent, 
  plan?: Plan, 
  userLocation?: { lat: number; lng: number },
  userId: string = "anonymous"
): Promise<AuditLog> {
  const id = crypto.randomUUID();
  
  // Ensure the primary intent has a hash
  if (!intent.hash) {
    intent.hash = await calculateIntentHash(intent);
  }

  const log: AuditLog = {
    id,
    timestamp: new Date().toISOString(),
    intent,
    intent_history: [],
    plan,
    userLocation,
    steps: [],
    toolExecutionLatencies: {
      latencies: {},
      totalToolExecutionTime: 0
    }
  };

  if (redis) {
    await redis.set(`${AUDIT_LOG_PREFIX}${id}`, JSON.stringify(log), { ex: 86400 * 7 }); // Store for 7 days
    
    // Track logs for this user
    try {
      await redis.lpush(`${USER_LOGS_PREFIX}${userId}`, id);
      await redis.ltrim(`${USER_LOGS_PREFIX}${userId}`, 0, 19); // Keep last 20 logs
    } catch (err) {
      console.warn("Failed to update user logs index:", err);
    }
  } else {
    console.warn("Redis not configured, audit log will not be persisted");
  }

  return log;
}

export async function getUserAuditLogs(userId: string, limit: number = 5): Promise<AuditLog[]> {
  if (!redis) return [];

  try {
    const ids = await redis.lrange(`${USER_LOGS_PREFIX}${userId}`, 0, limit - 1);
    if (!ids || ids.length === 0) return [];

    const logs = await Promise.all(ids.map(id => getAuditLog(id)));
    return logs.filter((log): log is AuditLog => !!log);
  } catch (err) {
    console.warn(`Failed to fetch audit logs for user ${userId}:`, err);
    return [];
  }
}

export async function updateAuditLog(id: string, update: Partial<AuditLog>): Promise<void> {
  if (redis) {
    const existing = await getAuditLog(id);
    if (existing) {
      const updated = { ...existing, ...update };
      await redis.set(`${AUDIT_LOG_PREFIX}${id}`, JSON.stringify(updated), { ex: 86400 * 7 });
    }
  }
}

export async function getAuditLog(id: string): Promise<AuditLog | undefined> {
  if (redis) {
    const data = await redis.get(`${AUDIT_LOG_PREFIX}${id}`);
    if (data) {
      return (typeof data === "string" ? JSON.parse(data) : data) as AuditLog;
    }
  }
  return undefined;
}

/**
 * Supersedes an existing intent in an audit log, maintaining a cryptographically linked history.
 */
export async function supersedeIntent(
  auditLogId: string,
  newIntent: Intent
): Promise<void> {
  const log = await getAuditLog(auditLogId);
  if (!log) throw new Error(`Audit log ${auditLogId} not found`);

  // Ensure cryptographic link
  newIntent.parent_intent_id = log.intent.id;
  newIntent.hash = await calculateIntentHash(newIntent);

  const updatedLog: AuditLog = {
    ...log,
    intent_history: [...(log.intent_history || []), log.intent],
    intent: newIntent,
    timestamp: new Date().toISOString()
  };

  if (redis) {
    await redis.set(`${AUDIT_LOG_PREFIX}${auditLogId}`, JSON.stringify(updatedLog), { ex: 86400 * 7 });
  }
}
