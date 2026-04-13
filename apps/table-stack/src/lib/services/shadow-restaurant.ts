/**
 * Shadow Restaurant Service
 *
 * Handles find-or-create logic for shadow restaurant discovery.
 * Extracted from ReservationOrchestrator to follow Single Responsibility Principle.
 *
 * @see T3: Decompose Orchestrators - Audit Roadmap
 */

import { getDb, restaurants, or, eq } from "@repo/database";
import { Logger } from "@repo/shared";
import { TableStackError } from "../error-factory";
import crypto from "crypto";

const logger = new Logger({ serviceName: "shadow-restaurant" });

export interface ShadowRestaurantResult {
  restaurant: typeof restaurants.$inferSelect;
  isNewlyCreated: boolean;
}

export class ShadowRestaurantService {
  /**
   * Find or create a shadow restaurant for the discovery flow.
   *
   * This allows users to make reservations at restaurants that haven't
   * yet claimed their profile on the platform.
   *
   * @param discoveryName - Restaurant name provided during discovery
   * @param discoveryEmail - Email associated with the restaurant
   * @returns The existing or newly created shadow restaurant
   */
  async resolve(
    discoveryName: string,
    discoveryEmail: string,
  ): Promise<ShadowRestaurantResult> {
    const db = getDb();

    // Try to find existing restaurant by email or name
    let restaurant = await db.query.restaurants.findFirst({
      where: or(
        eq(restaurants.ownerEmail, discoveryEmail),
        eq(restaurants.name, discoveryName),
      ),
    });

    if (restaurant) {
      return { restaurant, isNewlyCreated: false };
    }

    // Create new shadow restaurant
    const slug = discoveryName
      .toLowerCase()
      .replace(/ /g, "-")
      .replace(/[^\w-]+/g, "");

    const [newShadow] = await db
      .insert(restaurants)
      .values({
        name: discoveryName,
        slug: `${slug}-${crypto.randomBytes(3).toString("hex")}`,
        ownerEmail: discoveryEmail,
        ownerId: "shadow",
        apiKey: `ts_shadow_${crypto.randomBytes(8).toString("hex")}`,
        isShadow: true,
        isClaimed: false,
      })
      .returning();

    if (!newShadow) {
      throw TableStackError.shadowRestaurantFailed(
        "Failed to create shadow restaurant",
      );
    }

    logger.info("Created shadow restaurant", {
      restaurantId: newShadow.id,
      name: newShadow.name,
      isShadow: newShadow.isShadow,
    });

    return { restaurant: newShadow, isNewlyCreated: true };
  }

  /**
   * Check if a restaurant is a shadow restaurant.
   */
  async isShadowRestaurant(restaurantId: string): Promise<boolean> {
    const db = getDb();
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
      columns: { isShadow: true },
    });

    return restaurant?.isShadow ?? false;
  }
}

// Export singleton instance
export const shadowRestaurantService = new ShadowRestaurantService();
