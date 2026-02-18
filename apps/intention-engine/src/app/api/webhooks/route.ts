import { NextRequest, NextResponse } from "next/server";
import { inferIntent } from "@/lib/intent";
import { generatePlan } from "@/lib/planner";
import { createAuditLog } from "@/lib/audit";
import { z } from "zod";
import { handleTableStackRejection } from "@/lib/listeners/tablestack";
import { verifySignature, signServiceToken } from "@repo/auth";
import { IdempotencyService, IDEMPOTENCY_KEY_HEADER, RealtimeService } from "@repo/shared";
import { redis } from "@/lib/redis-client";
import { getAblyClient } from "@repo/shared";
import { NervousSystemObserver, type TableVacatedEvent } from "@/lib/listeners/nervous-system-observer";

export const runtime = "edge";

const WebhookEventSchema = z.object({
  event: z.string(),
  // Fields for high_value_guest_reservation
  guest: z.object({
    name: z.string(),
    email: z.string(),
    visitCount: z.number(),
    defaultDeliveryAddress: z.string().optional().nullable(),
  }).optional(),
  reservation: z.object({
    id: z.string().optional(),
    restaurantName: z.string(),
    startTime: z.string(),
    partySize: z.number(),
  }).optional(),
  // Fields for reservation_rejected (can overlap)
  guestEmail: z.string().optional(),
  startTime: z.string().optional(),
  partySize: z.number().optional(),
  visitCount: z.number().optional(),
  preferences: z.record(z.unknown()).optional(),
  // Fields for table_vacated (from TableStack)
  tableId: z.string().optional(),
  restaurantId: z.string().optional(),
  restaurantName: z.string().optional(),
  restaurantSlug: z.string().optional(),
  capacity: z.number().optional(),
  timestamp: z.string().optional(),
  traceId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature");
    const timestamp = Number(req.headers.get("x-timestamp"));
    const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);

    // Fail-Fast: Security Check
    if (!signature || !timestamp || !(await verifySignature(rawBody, signature, timestamp))) {
      console.warn("[IntentionEngine Webhook] Unauthorized request blocked");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Idempotency Check
    if (idempotencyKey) {
      const idempotencyService = new IdempotencyService(redis);
      const isDuplicate = await idempotencyService.isDuplicate(idempotencyKey);
      if (isDuplicate) {
        return NextResponse.json({ message: "Event already processed", duplicate: true });
      }
    }

    const body = JSON.parse(rawBody);
    console.log("[IntentionEngine Webhook] Received:", JSON.stringify(body, null, 2));

    const validatedBody = WebhookEventSchema.safeParse(body);
    if (!validatedBody.success) {
      console.warn("[IntentionEngine Webhook] Schema mismatch:", validatedBody.error.format());
      return NextResponse.json({ message: "Event received but schema mismatch" }, { status: 200 });
    }

    const { event, guest, reservation, guestEmail, restaurantName, startTime, partySize, visitCount, preferences } = validatedBody.data;

    if (event === 'reservation_rejected') {
      const failoverPayload = {
        guestEmail: guestEmail || "",
        restaurantName: restaurantName || "",
        startTime: startTime || "",
        partySize: partySize || 0,
        visitCount: visitCount || 0,
        preferences: preferences || {},
      };

      const result = await handleTableStackRejection(failoverPayload);

      // Push the alternative to the user's frontend via Ably
      const ably = getAblyClient();
      if (ably && result.plan) {
        try {
          const token = await signServiceToken({ purpose: 'failover_update' });
          const channel = ably.channels.get('nervous-system:updates');
          await channel.publish('FailoverAlternative', {
            token,
            data: {
              guestEmail: failoverPayload.guestEmail,
              originalRestaurant: failoverPayload.restaurantName,
              alternativePlan: result.plan,
              hypotheses: result.hypotheses,
              timestamp: new Date().toISOString(),
            },
          });
          console.log(`[Failover Orchestrator] Alternative pushed to Ably for ${failoverPayload.guestEmail}`);
        } catch (err) {
          console.error('[Failover Orchestrator] Ably publish failed:', err);
        }
      }

      return NextResponse.json({
        message: "Failover initiated",
        hypotheses: result.hypotheses,
        plan_id: result.plan?.intent_id
      });
    }

    if (event === 'high_value_guest_reservation' && guest && reservation) {
      // Strategic Synergy: High-value guest detected.
      // Proactively suggest a delivery or transport workflow if they have a saved address.

      let proactiveText = `Guest ${guest.name} (High Value, ${guest.visitCount} visits) just booked at ${reservation.restaurantName}.`;

      if (guest.defaultDeliveryAddress) {
        proactiveText += ` Suggest a delivery quote from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} for after their reservation.`;
      } else {
        proactiveText += ` Prepare a welcome message or special offer for their arrival.`;
      }

      console.log("[IntentionEngine Webhook] Proactive Trigger:", proactiveText);

      // We could trigger internal intent processing here
      // For now, we log the proactive orchestration intent
      const { hypotheses } = await inferIntent(proactiveText, []);
      const intent = hypotheses.primary;
      const plan = await generatePlan(proactiveText);

      await createAuditLog(intent, plan, undefined, `webhook:${guest.email}`);

      return NextResponse.json({
        message: "High-value guest event processed",
        proactive_action: guest.defaultDeliveryAddress ? "delivery_quote_suggested" : "welcome_offer_prepared"
      });
    }

    // ========================================================================
    // TABLE VACATED EVENT - Proactive Re-engagement
    // ========================================================================
    // Triggered when TableStack releases a table back to available status.
    // The Nervous System Observer will:
    // 1. Query Redis for users who failed to book this restaurant
    // 2. Generate personalized re-engagement messages via LLM
    // 3. Push notifications to user channels via Ably
    //
    // Architecture:
    // - TableStack → Ably Webhook → /api/webhooks → NervousSystemObserver → Ably User Channel
    //
    if (event === 'table_vacated') {
      const { tableId, restaurantId, restaurantName, restaurantSlug, capacity, timestamp, traceId } = validatedBody.data;

      if (!tableId || !restaurantId) {
        console.warn("[TableVacated] Missing required fields (tableId or restaurantId)");
        return NextResponse.json({ message: "Event received but missing required fields" }, { status: 200 });
      }

      console.log(`[TableVacated] Table ${tableId} at ${restaurantName || restaurantId} is now available`);

      // Create TableVacated event payload
      const tableVacatedEvent: TableVacatedEvent = {
        tableId,
        restaurantId,
        restaurantName: restaurantName || undefined,
        restaurantSlug: restaurantSlug || undefined,
        capacity: capacity || undefined,
        timestamp: timestamp || new Date().toISOString(),
        traceId: traceId || undefined,
      };

      // Use Nervous System Observer to handle proactive re-engagement
      const observer = new NervousSystemObserver();
      const token = await signServiceToken({
        event: 'TableVacated',
        data: tableVacatedEvent,
        timestamp: Date.now(),
      });

      const result = await observer.handleTableVacated({
        event: tableVacatedEvent,
        token,
      });

      if (result.success) {
        console.log(
          `[TableVacated] Proactive re-engagement complete: ${result.usersNotified} users notified${result.llmGeneratedContent ? ` [intent: ${result.llmGeneratedContent.proactiveIntent}]` : ''}`
        );

        return NextResponse.json({
          message: "Table vacated event processed",
          usersNotified: result.usersNotified,
          llmGenerated: !!result.llmGeneratedContent,
          proactiveIntent: result.llmGeneratedContent?.proactiveIntent,
          suggestedAction: result.llmGeneratedContent?.suggestedAction,
        });
      } else {
        console.warn("[TableVacated] Re-engagement failed:", result.error);
        return NextResponse.json({
          message: "Table vacated event received but re-engagement failed",
          error: result.error,
        }, { status: 200 });
      }
    }

    return NextResponse.json({ message: "Event ignored" });
  } catch (error: any) {
    console.error("[IntentionEngine Webhook] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
