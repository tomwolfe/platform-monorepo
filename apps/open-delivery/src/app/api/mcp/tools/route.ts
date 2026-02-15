import { NextResponse } from "next/server";
import { AppCapabilitiesSchema, TOOLS, TOOL_METADATA } from "@repo/mcp-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function GET() {
  const capabilities = {
    app_name: "open-delivery",
    version: "0.1.0",
    tools: [
      {
        name: TOOLS.openDelivery.calculateQuote.name,
        description: TOOLS.openDelivery.calculateQuote.description,
        inputSchema: zodToJsonSchema(TOOLS.openDelivery.calculateQuote.schema),
        requires_confirmation: (TOOL_METADATA as any).quote_delivery.requires_confirmation,
      },
      {
        name: TOOLS.openDelivery.getDriverLocation.name,
        description: TOOLS.openDelivery.getDriverLocation.description,
        inputSchema: zodToJsonSchema(TOOLS.openDelivery.getDriverLocation.schema),
        requires_confirmation: false,
      },
    ],
  };

  return NextResponse.json(AppCapabilitiesSchema.parse(capabilities));
}
