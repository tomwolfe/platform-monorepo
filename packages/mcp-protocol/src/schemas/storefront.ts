import { z } from "zod";

export const ListVendorsSchema = z.object({
  latitude: z.number().describe("Latitude for location-based search."),
  longitude: z.number().describe("Longitude for location-based search."),
  radius_km: z.number().optional().default(10).describe("Search radius in kilometers.")
});

export const GetMenuSchema = z.object({
  store_id: z.string().describe("The internal ID of the store.")
});

export const FindProductNearbySchema = z.object({
  product_query: z.string().describe("The product to search for."),
  user_lat: z.number().describe("User latitude."),
  user_lng: z.number().describe("User longitude."),
  max_radius_miles: z.number().optional().default(10).describe("Search radius in miles.")
});

export const ReserveStockItemSchema = z.object({
  product_id: z.string().describe("The ID of the product to reserve."),
  venue_id: z.string().describe("The ID of the venue."),
  quantity: z.number().describe("The quantity to reserve."),
  user_email: z.string().optional().describe("User email for the reservation.")
});

export const CreateProductSchema = z.object({
  name: z.string().describe("Product name."),
  description: z.string().optional().describe("Product description."),
  price: z.number().describe("Product price."),
  category: z.string().describe("Product category.")
});

export const UpdateProductSchema = z.object({
  product_id: z.string().describe("The ID of the product to update."),
  name: z.string().optional().describe("New product name."),
  description: z.string().optional().describe("New product description."),
  price: z.number().optional().describe("New product price."),
  category: z.string().optional().describe("New product category.")
});

export const DeleteProductSchema = z.object({
  product_id: z.string().describe("The ID of the product to delete.")
});
