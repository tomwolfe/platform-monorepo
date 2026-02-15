import { z } from "zod";

export const GetLiveOperationalStateSchema = z.object({
  restaurant_id: z.string().describe("The unique identifier for the restaurant.")
});

export const LiveStateSchema = z.object({
  restaurant_id: z.string().describe("The unique identifier for the restaurant."),
});
