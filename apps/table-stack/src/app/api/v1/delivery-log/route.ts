export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@tablestack/lib/auth";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  formatApiError,
  IdempotencyService,
  getRedisClient,
  ServiceNamespace,
  withInternalWebhookAuth,
  InternalWebhookContext,
} from "@repo/shared";

export const runtime = "nodejs";

const idempotencyService = new IdempotencyService(
  getRedisClient(ServiceNamespace.TABLESTACK),
);

export async function POST(req: NextRequest) {
  return withInternalWebhookAuth(
    async (ctx) => {
      const { error, status, authContext } = await validateRequest(req);
      if (error) return NextResponse.json({ message: error }, { status });

      const body = ctx.parsedBody as Record<string, unknown>;
      const {
        restaurantId,
        orderId,
        pickupAddress,
        deliveryAddress,
        customerId,
        priceDetails,
      } = body;

      const targetRestaurantId = authContext!.isInternal
        ? restaurantId
        : authContext!.restaurantId;

      if (!targetRestaurantId) {
        return NextResponse.json(
          { message: "Missing restaurantId" },
          { status: 400 },
        );
      }

      if (
        !authContext!.isInternal &&
        targetRestaurantId !== authContext!.restaurantId
      ) {
        return NextResponse.json(
          { message: "Unauthorized access to this restaurant" },
          { status: 403 },
        );
      }

      // Broadcast to dashboard
      await NotifyService.broadcast(targetRestaurantId, "DELIVERY_LOG_ENTRY", {
        orderId,
        pickupAddress,
        deliveryAddress,
        customerId,
        priceDetails,
        status: "dispatched",
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json({ message: "Delivery log entry created" });
    },
    { idempotencyService },
  )(req);
}
