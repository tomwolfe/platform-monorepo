import { NextResponse } from "next/server";
import { AppCapabilitiesSchema, TOOLS, TOOL_METADATA } from "@repo/mcp-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function GET() {
  const capabilities = {
    app_name: "store-front",
    version: "0.1.0",
    tools: [
      {
        name: TOOLS.storeFront.listVendors.name,
        description: TOOLS.storeFront.listVendors.description,
        inputSchema: zodToJsonSchema(TOOLS.storeFront.listVendors.schema),
        requires_confirmation: (TOOL_METADATA as any).get_local_vendors.requires_confirmation,
      },
      {
        name: TOOLS.storeFront.getMenu.name,
        description: TOOLS.storeFront.getMenu.description,
        inputSchema: zodToJsonSchema(TOOLS.storeFront.getMenu.schema),
        requires_confirmation: false,
      },
    ],
  };

  return NextResponse.json(AppCapabilitiesSchema.parse(capabilities));
}
