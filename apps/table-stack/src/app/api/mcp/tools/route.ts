import { NextResponse } from "next/server";
import { AppCapabilitiesSchema, TOOLS, TOOL_METADATA } from "@repo/mcp-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function GET() {
  const capabilities = {
    app_name: "table-stack",
    version: "0.1.0",
    tools: [
      {
        name: TOOLS.tableStack.getAvailability.name,
        description: TOOLS.tableStack.getAvailability.description,
        inputSchema: zodToJsonSchema(TOOLS.tableStack.getAvailability.schema),
        requires_confirmation: (TOOL_METADATA as any).check_availability.requires_confirmation,
      },
      {
        name: TOOLS.tableStack.bookTable.name,
        description: TOOLS.tableStack.bookTable.description,
        inputSchema: zodToJsonSchema(TOOLS.tableStack.bookTable.schema),
        requires_confirmation: (TOOL_METADATA as any).book_tablestack_reservation.requires_confirmation,
      },
      {
        name: (TOOLS.tableStack as any).getLiveOperationalState.name,
        description: (TOOLS.tableStack as any).getLiveOperationalState.description,
        inputSchema: zodToJsonSchema((TOOLS.tableStack as any).getLiveOperationalState.schema),
        requires_confirmation: false,
      },
    ],
  };

  return NextResponse.json(AppCapabilitiesSchema.parse(capabilities));
}
