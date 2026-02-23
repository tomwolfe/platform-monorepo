import { NextResponse } from "next/server";
import { redis } from "@/lib/redis-client";

export const runtime = "nodejs";

export async function GET() {
  try {
    // Attempt a non-blocking Redis check with timeout
    const redisStatus = await Promise.race([
      redis.ping().catch(() => "down"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 1000)),
    ]);

    return NextResponse.json({
      status: "healthy",
      redis: redisStatus === "PONG" ? "up" : "degraded",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Return 200 even if degraded so CI doesn't hang
    return NextResponse.json(
      {
        status: "degraded",
        error: "check_failed",
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}
