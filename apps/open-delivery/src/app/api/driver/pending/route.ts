import { NextRequest, NextResponse } from "next/server";

async function getHandler(_request: NextRequest) {
  return NextResponse.json({
    orders: [],
    count: 0,
    timestamp: new Date().toISOString(),
  });
}

export const GET = getHandler;
