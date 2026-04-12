import { NextRequest, NextResponse } from "next/server";
import { withUnifiedApiHandler } from "@repo/shared/middleware/api-error-wrapper";
import { withCronAuth } from "@repo/shared/middleware/cron-auth";
import { Logger } from "@repo/shared/logger";
import { withDistributedLock } from "@repo/shared/services/distributed-lock";
import { PendingOrderVerificationService } from "@/lib/services/pending-order-verification.service";

export const maxDuration = 10; // Vercel Hobby limit

const logger = new Logger({ serviceName: "verify-pending-cron" });

/**
 * Background Verification Sweeper Endpoint
 *
 * PROBLEM SOLVED:
 * - Users pay on mobile, then close browser before confirmation
 * - Money is taken, but order never confirmed (no Ably event dispatched)
 *
 * SOLUTION:
 * - Cron runs every 5 minutes via QStash
 * - Queries orders with paymentTxHash but status = 'pending_verification'
 * - Verifies transactions asynchronously on-chain
 * - Confirms orders and dispatches drivers even if user is offline
 *
 * SECURITY:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: only processes pending verification orders
 *
 * Usage:
 * POST /api/cron/verify-pending
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

async function postHandler(req: NextRequest) {
  const service = new PendingOrderVerificationService();
  return service.processPendingOrders(req);
}

async function getHandler(_req: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "Verify pending cron endpoint is healthy",
    endpoint: "/api/cron/verify-pending",
  });
}

// Wrap handlers with cron authentication and distributed lock
export const POST = withCronAuth(
  withUnifiedApiHandler(
    async (req: NextRequest) => {
      const lockKey = "cron:open-delivery:verify-pending";
      const lockTtlSeconds = 120; // 2 minutes for batch processing

      try {
        return await withDistributedLock(lockKey, lockTtlSeconds, async () =>
          postHandler(req),
        );
      } catch (error) {
        // If lock acquisition fails, return 200 OK to indicate graceful skip
        if (
          error instanceof Error &&
          error.message.includes("Failed to acquire distributed lock")
        ) {
          logger.info(
            "Verify-pending cron skipped - another instance is running",
          );
          return NextResponse.json({
            success: true,
            skipped: true,
            message: "Another instance is running",
          });
        }
        throw error;
      }
    },
    { serviceName: "verify-pending-cron" },
  ),
);
export const GET = withCronAuth(
  withUnifiedApiHandler(getHandler, { serviceName: "verify-pending-cron" }),
);
