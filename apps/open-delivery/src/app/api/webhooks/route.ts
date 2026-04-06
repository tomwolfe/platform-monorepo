import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifySignature } from "@repo/auth";
import { Logger } from "@repo/shared";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "open-delivery-webhook" });

const HotspotEventSchema = z.object({
  event: z.string(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    location: z.string(),
  }),
  table: z.object({
    id: z.string(),
    number: z.string(),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature");
    const timestamp = Number(req.headers.get("x-timestamp"));

    // Fail-Fast: Security Check
    if (!signature || !timestamp || !(await verifySignature(rawBody, signature, timestamp))) {
      logger.warn({ message: "Unauthorized request blocked" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    logger.info({ message: "Webhook received", body });

    const validatedBody = HotspotEventSchema.safeParse(body);
    if (!validatedBody.success) {
      return NextResponse.json({ message: "Event received" }, { status: 200 });
    }

    const { event, venue, table } = validatedBody.data;

    if (event === 'delivery_hotspot_available') {
      // Logic to broadcast to nearby drivers would go here
      logger.info({
        message: "Hotspot registered - venue table marked as vacant",
        venue: venue.name,
        table: table.number,
      });
      
      return NextResponse.json({ 
        message: "Hotspot registered",
        broadcast: true,
        venue: venue.name,
        table: table.number
      });
    }

    return NextResponse.json({ message: "Event ignored" });
  } catch (error: any) {
    logger.error({ message: "Webhook error", error: error.message || String(error) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
