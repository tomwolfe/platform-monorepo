export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@repo/shared/auth/gateway";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  withUnifiedApiHandler,
  formatApiError,
  formatApiSuccess,
  getRedisClient,
  ServiceNamespace,
  withInternalWebhookAuth,
  IdempotencyService,
  InternalWebhookContext,
} from "@repo/shared";
import { z } from "zod";

export const runtime = "nodejs";

const idempotencyService = new IdempotencyService(
  getRedisClient(ServiceNamespace.TS),
);

const ExternalDeliverySchema = z.object({
  restaurantId: z.string().min(1, "restaurantId is required"),
  orderId: z.string().min(1, "orderId is required"),
  status: z.string().min(1, "status is required"),
});

async function postHandler(req: NextRequest, context: InternalWebhookContext) {
  const body = context.parsedBody;
  const traceId = req.headers.get("x-trace-id");

  const validationResult = ExternalDeliverySchema.safeParse(body);
  if (!validationResult.success) {
    return NextResponse.json(
      formatApiError(
        new Error(
          `Validation failed: ${validationResult.error.errors.map((e) => e.message).join(", ")}`,
        ),
        "VALIDATION_ERROR",
      ),
      { status: 400 },
    );
  }

  const {
    restaurantId,
    orderId,
    status: deliveryStatus,
  } = validationResult.data;

  const targetRestaurantId = restaurantId;

  if (!targetRestaurantId) {
    return NextResponse.json(
      formatApiError(new Error("Missing restaurantId"), "VALIDATION_ERROR"),
      { status: 400 },
    );
  }

  await NotifyService.notifyExternalDelivery(targetRestaurantId, {
    orderId,
    status: deliveryStatus,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json(
    formatApiSuccess(
      { message: "Delivery update broadcasted" },
      { traceId: traceId || undefined },
    ),
  );
}

export const POST = withUnifiedApiHandler(
  async (req, ctx) => {
    const context = await ctx.params;
    return postHandler(req, {
      parsedBody: await req.json(),
    } as InternalWebhookContext);
  },
  { serviceName: "external-delivery" },
);
