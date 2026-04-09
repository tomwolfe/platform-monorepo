export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb, restaurantWaitlist } from "@repo/database";
import { and, eq, sql } from "@repo/database";
import { validateRequest } from "@tablestack/lib/auth";
import {
  withApiErrorHandler,
  formatApiSuccess,
  validationErrorResponse,
  forbiddenErrorResponse,
  Logger,
} from "@repo/shared";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack" });

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get("restaurantId");
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!restaurantId || !uuidRegex.test(restaurantId)) {
    return NextResponse.json(
      validationErrorResponse(
        "Missing or invalid restaurantId (UUID expected)",
      ),
      { status: 400 },
    );
  }

  // Pagination parameters
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100); // Max 100
  const offset = parseInt(searchParams.get("offset") || "0");

  const traceId = req.headers.get("x-trace-id") || "no-trace-id";
  logger.info(`Waitlist query for restaurant: ${restaurantId}`, {
    restaurantId,
    limit,
    offset,
    traceId,
  });

  const { error, status, context } = await validateRequest(req);
  if (error)
    return NextResponse.json(forbiddenErrorResponse(error), { status });

  if (!context?.isInternal && restaurantId !== context?.restaurantId) {
    return NextResponse.json(forbiddenErrorResponse("Unauthorized access"), {
      status: 403,
    });
  }

  const entries = await getDb().query.restaurantWaitlist.findMany({
    where: and(
      eq(restaurantWaitlist.restaurantId, restaurantId),
      eq(restaurantWaitlist.status, "waiting"),
    ),
    limit,
    offset,
  });

  // Get total count for pagination metadata
  const totalCount = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(restaurantWaitlist)
    .where(
      and(
        eq(restaurantWaitlist.restaurantId, restaurantId),
        eq(restaurantWaitlist.status, "waiting"),
      ),
    );

  return NextResponse.json(
    formatApiSuccess({
      restaurantId,
      waitlistCount: entries.length,
      totalCount: totalCount[0]?.count || 0,
      pagination: {
        limit,
        offset,
        hasMore: offset + entries.length < (totalCount[0]?.count || 0),
      },
      entries,
    }),
  );
}

export const GET = withApiErrorHandler(getHandler, {
  serviceName: "table-stack-waitlist",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
