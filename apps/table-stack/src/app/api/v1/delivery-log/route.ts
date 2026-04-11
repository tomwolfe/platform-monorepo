export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@repo/shared/auth/gateway";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  formatApiError,
  formatApiSuccess,
  IdempotencyService,
  getRedisClient,
  ServiceNamespace,
  withInternalWebhookAuth,
} from "@repo/shared";
import { z } from "zod";

export const runtime = "nodejs";

const idempotencyService = new IdempotencyService(
  getRedisClient(ServiceNamespace.TABLESTACK),
);

const DeliveryLogSchema = z.object({
  restaurantId: z.string().min(1),
  orderId: z.string().min(1),
  pickupAddress: z.string().optional(),
  deliveryAddress: z.string().optional(),
  customerId: z.string().optional(),
  priceDetails: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  return withInternalWebhookAuth(
    async (ctx) => {
      const { error, status, authContext } = await validateRequest(req);
      if (error)
        return NextResponse.json(
          formatApiError(new Error(error), "VALIDATION_ERROR"),
          { status },
        );

      const parseResult = DeliveryLogSchema.safeParse(ctx.parsedBody);
      if (!parseResult.success) {
        return NextResponse.json(
          formatApiError(
            new Error(parseResult.error.message),
            "VALIDATION_ERROR",
          ),
          { status: 400 },
        );
      }

      const {
        restaurantId,
        orderId,
        pickupAddress,
        deliveryAddress,
        customerId,
        priceDetails,
      } = parseResult.data;

      const targetRestaurantId = authContext!.isInternal
        ? restaurantId
        : authContext!.resourceId;

      if (!targetRestaurantId) {
        return NextResponse.json(
          { message: "Missing restaurantId" },
          { status: 400 },
        );
      }

      if (
        !authContext!.isInternal &&
        targetRestaurantId !== authContext!.resourceId
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

      return NextResponse.json(
        formatApiSuccess({ message: "Delivery log entry created" }),
      );
    },
    { idempotencyService },
  )(req);
}
