import { AppConfig } from "@repo/shared";

/**
 * MCP Transport and Parameter Configuration
 */
export const mcpConfig = {
  transport: {
    opendeliver: AppConfig.getOpenDeliveryMcpUrl(),
    tablestack: AppConfig.getTableStackMcpUrl(),
  },
  parameter_aliases: {
    "restaurant_id": "venue_id",
    "merchant_id": "venue_id",
    "restaurantName": "pickup_address",
    "restaurant_name": "pickup_address",
    "pickup_address": "restaurant_address",
    "delivery_address": "target_address",
  }
};
