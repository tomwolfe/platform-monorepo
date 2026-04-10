import { NextRequest, NextResponse } from "next/server";
import { getDb, eq, lt, and } from "@repo/database";
import {
  restaurantReservations,
  restaurantTables,
  outboxDlq,
} from "@repo/database";
import {
  withCronAuth,
  Logger,
  getRedisClient,
  ServiceNamespace,
  withDistributedLock,
  createErrorResponse,
} from "@repo/shared";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack" });

async function getCronHandler(req: NextRequest) {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);

    // 1. Remove expired unverified reservations
    const deletedReservations = await getDb()
      .delete(restaurantReservations)
      .where(
        and(
          eq(restaurantReservations.isVerified, false),
          lt(restaurantReservations.createdAt, fifteenMinutesAgo),
        ),
      );

    // 2. Auto-archive "dirty" tables to "vacant"
    const cleanedTables = await getDb()
      .update(restaurantTables)
      .set({ status: "vacant", updatedAt: new Date() })
      .where(
        and(
          eq(restaurantTables.status, "dirty"),
          lt(restaurantTables.updatedAt, twentyMinutesAgo),
        ),
      );

    // 3. Clean up orphaned confirmation token index keys in Redis
    // When a primary confirmation:{token} key expires via TTL, the
    // confirmation:exec:{executionId} index key becomes orphaned.
    // This scans and removes those orphaned entries.
    let orphanedConfirmationsRemoved = 0;
    try {
      const ieRedis = getRedisClient(ServiceNamespace.IE);
      const execKeys = await ieRedis.keys("confirmation:exec:*");

      for (const execKey of execKeys) {
        const token = await ieRedis.get(execKey);
        if (token) {
          const primaryKey = `confirmation:${token}`;
          const exists = await ieRedis.exists(primaryKey);
          if (!exists) {
            // Primary key is gone — this index entry is orphaned
            await ieRedis.del(execKey);
            orphanedConfirmationsRemoved++;
          }
        } else {
          // Index key points to nothing — definitely orphaned
          await ieRedis.del(execKey);
          orphanedConfirmationsRemoved++;
        }
      }
    } catch (error) {
      logger.warn("Redis confirmation cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 4. Clean up expired DLQ (Dead Letter Queue) records older than 30 days
    // Prevents permanent database bloat from high failure volumes
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deletedDlqRecords = await getDb()
      .delete(outboxDlq)
      .where(lt(outboxDlq.dlqCreatedAt, thirtyDaysAgo));

    return NextResponse.json({
      message: "Cleanup successful",
      timestamp: new Date().toISOString(),
      expiredReservationsRemoved: deletedReservations.rowCount,
      dirtyTablesCleaned: cleanedTables.rowCount,
      orphanedConfirmationsRemoved,
      dlqRecordsRemoved: deletedDlqRecords.rowCount,
    });
  } catch (error) {
    logger.error("Cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(
      error instanceof Error ? error.message : "Internal server error",
      500,
      "INTERNAL_ERROR",
    );
  }
}

// Wrap handler with cron authentication and distributed lock
export const GET = withCronAuth(async (req: NextRequest) => {
  const lockKey = "cron:table-stack:cleanup";
  const lockTtlSeconds = 60; // 60 seconds should be enough for cleanup

  try {
    return await withDistributedLock(lockKey, lockTtlSeconds, async () =>
      getCronHandler(req),
    );
  } catch (error) {
    // If lock acquisition fails, return 200 OK to indicate graceful skip
    if (
      error instanceof Error &&
      error.message.includes("Failed to acquire distributed lock")
    ) {
      logger.info("Cleanup cron skipped - another instance is running");
      return NextResponse.json({
        skipped: true,
        message: "Another instance is running",
      });
    }
    throw error;
  }
});
