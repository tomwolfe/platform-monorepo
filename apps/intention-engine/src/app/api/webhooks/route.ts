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
import { redis } from "@/lib/redis-client";
import { IDEMPOTENCY_KEY_HEADER } from "@repo/shared";
import { WebhookDispatcherService, createWebhookDispatcherService } from "@/lib/engine/webhook-dispatcher-service";

export const runtime = "edge";

// ============================================================================
// SERVICE INSTANCE
// ============================================================================

const webhookDispatcherService = createWebhookDispatcherService(redis);

// ============================================================================
// API HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature");
    const timestamp = Number(req.headers.get("x-timestamp"));
    const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);

    // Fail-Fast: Security Check
    if (!signature || !timestamp || !(await webhookDispatcherService.verifySignature(rawBody, signature, timestamp))) {
      console.warn("[Webhooks] Unauthorized request blocked");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Idempotency Check
    if (idempotencyKey) {
      const isDuplicate = await webhookDispatcherService.checkIdempotency(idempotencyKey);
      if (isDuplicate) {
        return NextResponse.json({ message: "Event already processed", duplicate: true });
      }
    }

    // Process webhook
    const result = await webhookDispatcherService.processWebhook({
      rawBody,
      signature,
      timestamp,
      idempotencyKey,
    });

    return NextResponse.json(result.data || { message: result.message }, { status: result.statusCode || 200 });
  } catch (error) {
    console.error("[Webhooks] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
