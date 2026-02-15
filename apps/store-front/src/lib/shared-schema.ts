import { z } from "zod";

export const SearchSchema = z.object({
  product_query: z.string().min(1, "Product query is required"),
  user_lat: z.number(),
  user_lng: z.number(),
  max_radius_miles: z.number().positive("Radius must be positive"),
});

export type SearchInput = z.infer<typeof SearchSchema>;
