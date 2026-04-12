import { NextRequest } from "next/server";
import { withCronAuth } from "@repo/shared/middleware/cron-auth";
import { PayoutVerificationService } from "@/lib/services/payout-verification.service";

export const maxDuration = 10; // Vercel Hobby limit

/**
 * Verify Tip Releases Cron Endpoint
 *
 * ASYNCHRONOUS TIP RELEASE VERIFICATION FOR NON-CUSTODIAL ESCROW
 *
 * How it works:
 * - /api/cron/payouts submits tip release transactions, saves tx hash, marks as 'released'
 * - This cron verifies the on-chain TipReleased event for each release transaction
 * - Confirms the driver actually received their tip from the escrow contract
 *
 * What it does:
 * 1. Queries all orders with escrowStatus = 'released' and payoutTxHash set
 * 2. Checks transaction receipts in parallel
 * 3. Parses TipReleased event logs to verify driver received funds
 * 4. Marks orders as 'completed' or 'failed' based on receipt status
 *
 * Security:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: only processes 'released' payouts
 *
 * Usage:
 * GET /api/cron/verify-payouts
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

async function getCronHandler(req: NextRequest) {
  const service = new PayoutVerificationService();
  return service.processPayoutVerifications(req);
}

/**
 * POST endpoint to manually trigger verification
 * Useful for testing or manual intervention
 */
async function postCronHandler(req: NextRequest) {
  return getCronHandler(req);
}

// Wrap handlers with cron authentication
export const GET = withCronAuth(getCronHandler);
export const POST = withCronAuth(postCronHandler);
