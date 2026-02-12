import { z } from "zod";
import { ToolDefinitionMetadata } from "./types";
import { env } from "../config";

export const RestaurantDiscoverySchema = z.object({
  restaurant_slug: z.string().describe("The slug of the restaurant (e.g., 'the-fancy-bistro')."),
});

export type RestaurantDiscoveryParams = z.infer<typeof RestaurantDiscoverySchema>;

export async function discover_restaurant(params: RestaurantDiscoveryParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = RestaurantDiscoverySchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + JSON.stringify(validated.error.format()) };
  }

  const { restaurant_slug } = validated.data;

  try {
    const response = await fetch(`${env.TABLESTACK_API_URL}/restaurant?slug=${restaurant_slug}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.TABLESTACK_INTERNAL_API_KEY || '',
      },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        result: {
          restaurantId: data.id,
          name: data.name,
          slug: data.slug,
          timezone: data.timezone,
          openingTime: data.openingTime,
          closingTime: data.closingTime,
        }
      };
    }

    const errorData = await response.json();
    return { success: false, error: errorData.message || "Restaurant not found" };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export const discoverRestaurantToolDefinition: ToolDefinitionMetadata = {
  name: "discover_restaurant",
  version: "1.0.0",
  description: "Resolves a restaurant slug to its internal ID and metadata using the TableStack API.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_slug: { type: "string", description: "The slug of the restaurant." }
    },
    required: ["restaurant_slug"]
  },
  return_schema: {
    restaurantId: "string",
    name: "string",
    slug: "string",
    timezone: "string",
    openingTime: "string",
    closingTime: "string"
  },
  timeout_ms: 10000,
  requires_confirmation: false,
  category: "search",
};
