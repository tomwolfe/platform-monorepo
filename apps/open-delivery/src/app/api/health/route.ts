import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    // Basic health check - just verify the API is running
    return NextResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        api: "up",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 }
    );
  }
}
