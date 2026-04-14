/**
 * Shadow Restaurant Service
 *
 * Handles find-or-create logic for shadow restaurant discovery.
 * Extracted from ReservationOrchestrator to follow Single Responsibility Principle.
 *
 * ## Discovery State Machine
 *
 * Shadow restaurants represent unclaimed restaurant profiles created during
 * the reservation discovery flow. The state transitions are:
 *
 * 1. **Unclaimed Shadow** (`isShadow=true, isClaimed=false`): Created when a
 *    user makes a reservation at a restaurant not yet on the platform.
 *    The restaurant receives a notification email with a claim token.
 *
 * 2. **Claimed Shadow** (`isShadow=true, isClaimed=true`): Restaurant owner
 *    clicks the claim link and completes onboarding. The shadow profile
 *    is converted to a full restaurant profile.
 *
 * 3. **Converted** (`isShadow=false, isClaimed=true`): After claim completion,
 *    the `isShadow` flag is cleared and the restaurant gains full platform access.
 *
 * Shadow restaurants use a special `ownerId: "shadow"` and API key prefix
 * `ts_shadow_` to distinguish them from regular restaurants.
 *
 * @see T3: Decompose Orchestrators - Audit Roadmap
 * @see T7: Dead Code & Metadata Audit
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
