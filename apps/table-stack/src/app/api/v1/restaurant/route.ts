export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@repo/database";
import { restaurants } from "@repo/database";
import { eq } from "@repo/database";
import { validateRequest } from "@tablestack/lib/auth";
import { withApiErrorHandler, formatApiSuccess } from "@repo/shared";

export const runtime = "nodejs";

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const id = searchParams.get("id");
  const apiKeyHeader =
    req.headers.get("x-api-key") || req.headers.get("x-internal-key");
  const isInternal =
    apiKeyHeader === process.env.INTERNAL_API_KEY ||
    apiKeyHeader === process.env.INTERNAL_SYSTEM_KEY;

  // Allow internal access by ID
  if (id && isInternal) {
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, id),
    });
    if (!restaurant) {
      return NextResponse.json(
        { message: "Restaurant not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(formatApiSuccess(restaurant));
  }

  // Allow public access if slug is provided
  if (slug) {
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.slug, slug),
    });

    if (!restaurant) {
      return NextResponse.json(
        { message: "Restaurant not found" },
        { status: 404 },
      );
    }

    // If internal key is provided, return sensitive data for tool integration
    if (isInternal) {
      return NextResponse.json(formatApiSuccess(restaurant));
    }

    // Sanitize response
    const { apiKey, ownerEmail, ownerId, ...publicRestaurant } = restaurant;
    return NextResponse.json(formatApiSuccess(publicRestaurant));
  }

  // If internal and no slug, return all restaurants (paginated)
  if (isInternal) {
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = Math.min(
      parseInt(searchParams.get("limit") || "100", 10),
      1000,
    );
    const offset = (Math.max(page, 1) - 1) * limit;

    const allRestaurants = await getDb().query.restaurants.findMany({
      limit,
      offset,
    });
    return NextResponse.json(formatApiSuccess(allRestaurants));
  }

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  const restaurantId = context?.restaurantId;

  if (!restaurantId) {
    return NextResponse.json(
      { message: "Restaurant ID not found in context" },
      { status: 403 },
    );
  }

  const restaurant = await getDb().query.restaurants.findFirst({
    where: eq(restaurants.id, restaurantId),
  });

  if (!restaurant) {
    return NextResponse.json(
      { message: "Restaurant not found" },
      { status: 404 },
    );
  }

  // Sanitize response
  const { apiKey, ownerEmail, ownerId, ...publicRestaurant } = restaurant;

  return NextResponse.json(formatApiSuccess(publicRestaurant));
}

export const GET = withApiErrorHandler(getHandler, "EXECUTION_FAILED");
