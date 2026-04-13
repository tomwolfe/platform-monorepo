import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
import { getPrivacyGateway } from "@repo/shared/services/privacy-gateway";
import type { Plan, Intent } from "./engine/types";
import type { AuditLog } from "./types";

const logger = new Logger({ serviceName: "audit" });

const AUDIT_LOG_PREFIX = "audit_log:";
const USER_LOGS_PREFIX = "user_logs:";
const AUDIT_LOGS_INDEX = "audit_logs:index";

let redis: ReturnType<typeof getRedisClient> | undefined;

function getRedis() {
  if (!redis) {
    try {
      redis = getRedisClient(ServiceNamespace.IE);
    } catch {
      // Redis not available during build
    }
  }
  return redis;
}

/**
 * Calculates a SHA-256 hash of the intent's core content for cryptographic linking.
 */
export async function calculateIntentHash(
  intent: Omit<Intent, "hash">,
): Promise<string> {
  const content = JSON.stringify({
    type: intent.type,
    parameters: intent.parameters,
    rawText: intent.rawText,
    parent_intent_id: intent.parent_intent_id,
  });

  const msgUint8 = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createAuditLog(
  intent: Intent,
  plan?: Plan,
  userLocation?: { lat: number; lng: number },
  userId: string = "anonymous",
  options?: { skipPrivacyScrubbing?: boolean },
): Promise<AuditLog> {
  const id = crypto.randomUUID();

  // Privacy Gateway: PII scrubbing is now OPT-OUT (not opt-in)
  // To skip scrubbing, explicitly pass { skipPrivacyScrubbing: true }
  let scrubbedText = intent.rawText;
  let scrubbedParameters = intent.parameters;
  let tokenMap: Record<string, string> = {};
  let detectedPii: string[] = [];

  if (!options?.skipPrivacyScrubbing) {
    try {
      const gateway = getPrivacyGateway();
      const privacyResult = await gateway.scrubMemoryEntry(
        intent.rawText,
        intent.parameters,
      );
      scrubbedText = privacyResult.scrubbedText;
      scrubbedParameters = privacyResult.scrubbedParameters;
      tokenMap = privacyResult.tokenMap;
      detectedPii = privacyResult.detectedPii;
    } catch (error) {
      // If privacy gateway fails, log warning but continue with original data
      // This ensures audit logs are still created even if PII scrubbing fails
      logger.warn("Privacy Gateway scrubbing failed, using original data", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Store scrubbed versions in the intent
  const scrubbedIntent = {
    ...intent,
    rawText: scrubbedText,
    parameters: scrubbedParameters,
  };

  // Ensure the primary intent has a hash (computed on scrubbed data)
  if (!scrubbedIntent.hash) {
    scrubbedIntent.hash = await calculateIntentHash(scrubbedIntent);
  }

  const log: AuditLog = {
    id,
    timestamp: new Date().toISOString(),
    intent: scrubbedIntent,
    intent_history: [],
    plan,
    userLocation,
    steps: [],
    toolExecutionLatencies: {
      latencies: {},
      totalToolExecutionTime: 0,
    },
    // Store token map in metadata for authorized reversal
    metadata: {
      piiTokenMap: Object.keys(tokenMap).length > 0 ? tokenMap : undefined,
      piiDetectedCount: detectedPii.length,
    },
  };

  const r = getRedis();
  if (r) {
    await r.set(`${AUDIT_LOG_PREFIX}${id}`, JSON.stringify(log), {
      ex: 86400 * 7,
    }); // Store for 7 days

    // Maintain sorted set index for efficient analytics queries
    try {
      await getRedis()?.zadd(AUDIT_LOGS_INDEX, {
        score: Date.now(),
        member: id,
      });
    } catch (err) {
      logger.warn("Failed to update audit log index", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Track logs for this user
    try {
      await getRedis()?.lpush(`${USER_LOGS_PREFIX}${userId}`, id);
      await getRedis()?.ltrim(`${USER_LOGS_PREFIX}${userId}`, 0, 19); // Keep last 20 logs
    } catch (err) {
      logger.warn("Failed to update user logs index", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.warn("Redis not configured, audit log will not be persisted");
  }

  return log;
}

export async function getUserAuditLogs(
  userId: string,
  limit: number = 5,
): Promise<AuditLog[]> {
  if (!redis) return [];

  try {
    const ids = await getRedis()?.lrange(
      `${USER_LOGS_PREFIX}${userId}`,
      0,
      limit - 1,
    );
    if (!ids || ids.length === 0) return [];

    const logs = await Promise.all(ids.map((id) => getAuditLog(id)));
    return logs.filter((log): log is AuditLog => !!log);
  } catch (err) {
    logger.warn(`Failed to fetch audit logs for user ${userId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function updateAuditLog(
  id: string,
  update: Partial<AuditLog>,
): Promise<void> {
  if (redis) {
    const existing = await getAuditLog(id);
    if (existing) {
      const updated = { ...existing, ...update };
      await getRedis()?.set(
        `${AUDIT_LOG_PREFIX}${id}`,
        JSON.stringify(updated),
        {
          ex: 86400 * 7,
        },
      );
    }
  }
}

export async function getAuditLog(id: string): Promise<AuditLog | undefined> {
  if (redis) {
    const data = await getRedis()?.get(`${AUDIT_LOG_PREFIX}${id}`);
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
  newIntent: Intent,
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
    timestamp: new Date().toISOString(),
  };

  if (redis) {
    await getRedis()?.set(
      `${AUDIT_LOG_PREFIX}${auditLogId}`,
      JSON.stringify(updatedLog),
      { ex: 86400 * 7 },
    );
  }
}
