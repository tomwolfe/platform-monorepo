import { getRedisClient, ServiceNamespace } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifySignature } from "@repo/auth";
import {
  IdempotencyService,
  IDEMPOTENCY_KEY_HEADER,
  safeParseJsonSync,
  withUnifiedApiHandler,
  AppError,
} from "@repo/shared";

// Schema for Ably message payloads from TableStack
const AblyStateSchema = z.object({
  name: z.string(), // e.g., "table_status_update"
  data: z.object({
    restaurantId: z.string(),
    tableId: z.string(),
    status: z.enum(["vacant", "occupied", "dirty"]),
    updatedAt: z.string(),
  }),
});

async function postHandler(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature");
  const timestamp = Number(req.headers.get("x-timestamp"));
  const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);

  // 1. Validate Webhook Security (HMAC)
  if (signature && timestamp) {
    const isValid = await verifySignature(rawBody, signature, timestamp);
    if (!isValid) {
      throw new AppError("UNAUTHORIZED", "Unauthorized", 401);
    }
  }

  // 2. Idempotency Check
  if (idempotencyKey) {
    const idempotencyService = new IdempotencyService(redis);
    const isDuplicate = await idempotencyService.isDuplicate(
      idempotencyKey,
      "ably_state_sync",
    );
    if (isDuplicate) {
      return NextResponse.json({ synced: true, duplicate: true });
    }
  }

  // 3. Safe JSON parsing
  const parseResult = safeParseJsonSync(rawBody);
  if (!parseResult.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid request body: ${parseResult.error}`,
      400,
    );
  }

  const body = parseResult.data;

  // 4. Validate Ably Webhook Schema
  const event = AblyStateSchema.parse(body);

  // 5. Mirror UI state to AI memory (Redis)
  // We use a separate prefix for state to avoid collisions if needed,
  // but the redis client already adds 'ie:'
  const key = `state:${event.data.restaurantId}:tables`;

  await redis.hset(key, {
    [event.data.tableId]: JSON.stringify({
      status: event.data.status,
      updatedAt: event.data.updatedAt,
    }),
  });

  // 6. Set TTL to ensure memory stays "fresh" (e.g., 2 hours)
  await redis.expire(key, 7200);

  return NextResponse.json({ synced: true });
}

export const POST = withUnifiedApiHandler(postHandler, {
  serviceName: "ably-bridge",
});
