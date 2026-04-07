/**
 * Webhooks API Route - Thin Controller Layer
 *
 * Delegates all business logic to WebhookDispatcherService.
 * This route handles:
 * - HTTP request/response handling
 * - Signature verification
 * - Idempotency checking
 * - Delegation to WebhookDispatcherService
 *
 * @see Phase 3.2: Route De-bloating & Abstraction
 * @see WebhookDispatcherService for business logic
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedisClient, ServiceNamespace, withApiErrorHandler, formatApiSuccess, Logger } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);
import { IDEMPOTENCY_KEY_HEADER } from "@repo/shared";
import { WebhookDispatcherService, createWebhookDispatcherService } from "@/lib/engine/webhook-dispatcher-service";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "webhooks" });

// ============================================================================
// SERVICE INSTANCE
// ============================================================================

const webhookDispatcherService = createWebhookDispatcherService(redis);

// ============================================================================
// API HANDLER
// ============================================================================

async function webhooksHandler(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature");
  const timestamp = Number(req.headers.get("x-timestamp"));
  const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);

  // Fail-Fast: Security Check
  if (!signature || !timestamp || !(await webhookDispatcherService.verifySignature(rawBody, signature, timestamp))) {
    logger.warn("Unauthorized request blocked");
    return NextResponse.json(
      formatApiSuccess({ error: "Unauthorized" }),
      { status: 401 }
    );
  }

  // Idempotency Check
  if (idempotencyKey) {
    const isDuplicate = await webhookDispatcherService.checkIdempotency(idempotencyKey);
    if (isDuplicate) {
      return NextResponse.json(
        formatApiSuccess({ message: "Event already processed", duplicate: true }),
        { status: 200, headers: { "x-idempotency-duplicate": "true" } }
      );
    }
  }

  // Process webhook
  const result = await webhookDispatcherService.processWebhook({
    rawBody,
    signature,
    timestamp,
    idempotencyKey,
  });

  return NextResponse.json(
    formatApiSuccess(result.data || { message: result.message }),
    { status: result.statusCode || 200 }
  );
}

export const POST = withApiErrorHandler(webhooksHandler, {
  serviceName: "webhooks",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
