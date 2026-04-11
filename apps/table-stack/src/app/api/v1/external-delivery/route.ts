export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@repo/shared/auth/gateway";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  withUnifiedApiHandler,
  formatApiError,
  getRedisClient,
  ServiceNamespace,
  withInternalWebhookAuth,
  IdempotencyService,
  InternalWebhookContext,
} from "@repo/shared";
import { z } from "zod";

export const runtime = "nodejs";

const idempotencyService = new IdempotencyService(
  getRedisClient(ServiceNamespace.TABLESTACK),
);

const ExternalDeliverySchema = z.object({
  restaurantId: z.string().min(1, "restaurantId is required"),
  orderId: z.string().min(1, "orderId is required"),
  status: z.string().min(1, "status is required"),
});

async function postHandler(req: NextRequest, context: InternalWebhookContext) {
  const body = context.parsedBody;
  const traceId = req.headers.get("x-trace-id");

  const { error, status, authContext } = await validateRequest(req);
  if (error)
    return NextResponse.json(
      formatApiError(new Error(error), "VALIDATION_ERROR"),
      { status },
    );

  // Validate request body with Zod schema
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

  // If it's internal API key, we allow specifying any restaurantId
  // If it's a restaurant API key, we ensure it matches the context
  const targetRestaurantId = authContext!.isInternal
    ? restaurantId
    : authContext!.resourceId;

  if (!targetRestaurantId) {
    return NextResponse.json(
      formatApiError(new Error("Missing restaurantId"), "VALIDATION_ERROR"),
      { status: 400 },
    );
  }

  if (
    !authContext!.isInternal &&
    targetRestaurantId !== authContext!.resourceId
  ) {
    return NextResponse.json(
      formatApiError(
        new Error("Unauthorized access to this restaurant"),
        "FORBIDDEN",
      ),
      { status: 403 },
    );
  }

  await NotifyService.notifyExternalDelivery(targetRestaurantId, {
    orderId,
    status: deliveryStatus,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json(
    formatApiSuccess({ message: "Delivery update broadcasted" }, { traceId }),
  );
}

export const POST = withUnifiedApiHandler(
  (req: NextRequest) =>
    withInternalWebhookAuth((ctx) => postHandler(req, ctx), {
      idempotencyService,
    })(req),
  { serviceName: "external-delivery" },
);
