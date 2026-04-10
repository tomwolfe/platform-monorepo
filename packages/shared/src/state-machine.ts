import { RealtimeService } from "./realtime";
import { Redis } from "@upstash/redis";
import { Logger } from "./logger";
import { CACHE_TIERS } from "./config/cache-tiers";

const logger = new Logger({ serviceName: "order-state-machine" });

export class OrderStateMachine {
  constructor(private redis: Redis) {}

  /**
   * Updates the status of an order and triggers side effects if necessary.
   * Standardizes decentralization by using the Ably mesh for cross-service reactivity.
   */
  async updateStatus(
    orderId: string,
    newStatus: string,
    orderData: {
      storeId: string;
      storeAddress: string;
      deliveryAddress: string;
      total: number;
      customerId: string;
    },
  ) {
    // 1. Persist state transition in Redis
    const previousStatus = await this.redis.get(`order:status:${orderId}`);
    // DB-01: Add explicit TTL to prevent memory bloat (7 days for order status)
    await this.redis.set(`order:status:${orderId}`, newStatus, {
      ex: CACHE_TIERS.EXTENDED * 7,
    });

    logger.info({
      message: "Order status transitioned",
      orderId,
      previousStatus: previousStatus || "INIT",
      newStatus,
    });

    // 2. Reactive Side Effects (Decentralized Reactivity)
    if (newStatus === "ready_for_pickup") {
      logger.info({
        message: "Triggering delivery.request",
        orderId,
      });

      // We emit an event to the mesh. Open-Delivery or Intention-Engine can listen.
      // This bypasses the need for Intention-Engine to manually orchestrate.
      await RealtimeService.publish(
        "nervous-system:delivery-updates",
        "delivery.request",
        {
          orderId,
          pickupAddress: orderData.storeAddress,
          deliveryAddress: orderData.deliveryAddress,
          restaurantId: orderData.storeId,
          customerId: orderData.customerId,
          total: orderData.total,
          timestamp: Date.now(),
        },
      );
    }

    return { success: true, from: previousStatus, to: newStatus };
  }
}
