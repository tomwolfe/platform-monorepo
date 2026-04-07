/**
 * Webhooks API Route - Thin Controller Layer
 *
 * Delegates all business logic to createWebhookHandler from @repo/shared.
 * Handles signature verification, idempotency, and event routing automatically.
 *
 * @see Phase 4: Consolidate Webhook Dispatching
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
import { createWebhookHandler, WebhookEvent, WebhookContext, WebhookHandlerResult } from "@repo/shared/server";

export const runtime = "nodejs";

const redis = getRedisClient(ServiceNamespace.SHARED);
const logger = new Logger({ serviceName: "open-delivery-webhook" });

// ============================================================================
// EVENT HANDLERS
// ============================================================================

async function handleDeliveryHotspotAvailable(
  event: WebhookEvent,
  _context: WebhookContext
): Promise<WebhookHandlerResult> {
  const venue = event.venue as { name: string };
  const table = event.table as { number: string };

  // Logic to broadcast to nearby drivers would go here
  logger.info("Hotspot registered - venue table marked as vacant", {
    venue: venue.name,
    table: table.number,
  });

  return {
    success: true,
    message: "Hotspot registered",
    data: {
      broadcast: true,
      venue: venue.name,
      table: table.number,
    },
  };
}

// ============================================================================
// API HANDLER
// ============================================================================

export const POST = createWebhookHandler(redis, {
  handlers: {
    delivery_hotspot_available: handleDeliveryHotspotAvailable,
  },
});
