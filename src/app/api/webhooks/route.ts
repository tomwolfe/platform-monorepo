import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "edge";

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
    const rawBody = await req.json();
    console.log("[OpenDeliver Webhook] Received:", JSON.stringify(rawBody, null, 2));

    const validatedBody = HotspotEventSchema.safeParse(rawBody);
    if (!validatedBody.success) {
      return NextResponse.json({ message: "Event received" }, { status: 200 });
    }

    const { event, venue, table } = validatedBody.data;

    if (event === 'delivery_hotspot_available') {
      // Logic to broadcast to nearby drivers would go here
      console.log(`[OpenDeliver Hotspot] Venue "${venue.name}" Table ${table.number} is now VACANT. Marking as Hyper-Local Drop-off Point.`);
      
      return NextResponse.json({ 
        message: "Hotspot registered",
        broadcast: true,
        venue: venue.name,
        table: table.number
      });
    }

    return NextResponse.json({ message: "Event ignored" });
  } catch (error: any) {
    console.error("[OpenDeliver Webhook] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
