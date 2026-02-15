import { z } from "zod";

export const CalculateQuoteSchema = z.object({
  pickup_address: z.string().describe("Address where the delivery starts."),
  delivery_address: z.string().describe("Address where the delivery ends."),
  items: z.array(z.string()).describe("List of items to be delivered.")
});

export const GetDriverLocationSchema = z.object({
  order_id: z.string().describe("The unique identifier of the order.")
});
