import { z } from "zod";
import { ToolDefinition } from "./types";

const ProductSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number(),
  category: z.string(),
});

export async function create_product(args: any) {
  // In a real system, this would call the StoreFront API
  console.log("Creating product:", args);
  return { success: true, product: { id: "new-id", ...args } };
}

export async function update_product(args: any) {
  console.log("Updating product:", args);
  return { success: true, product: args };
}

export async function delete_product(args: any) {
  console.log("Deleting product:", args);
  return { success: true };
}

export const storefrontTools: Record<string, ToolDefinition> = {
  create_product: {
    name: "create_product",
    version: "1.0.0",
    description: "Authorized to create new products in the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        category: { type: "string" }
      },
      required: ["name", "price", "category"]
    },
    return_schema: { success: "boolean", product: "object" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: create_product
  },
  update_product: {
    name: "update_product",
    version: "1.0.0",
    description: "Authorized to update existing products in the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        category: { type: "string" }
      },
      required: ["product_id"]
    },
    return_schema: { success: "boolean", product: "object" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: update_product
  },
  delete_product: {
    name: "delete_product",
    version: "1.0.0",
    description: "Authorized to delete products from the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" }
      },
      required: ["product_id"]
    },
    return_schema: { success: "boolean" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: delete_product
  }
};
