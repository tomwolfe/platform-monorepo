"use server";

import { after } from "next/server";
import {
  getDb,
  restaurants,
  orders,
  orderItems,
  users,
  sql,
  restaurantProducts,
  eq,
  type CryptoAmount,
  outbox,
} from "@repo/database";
import { currentUser } from "@clerk/nextjs/server";
import {
  OutboxService,
  OutboxRelayService,
  isReplayAllowed,
  rollbackReplayGuard,
  AppConfig,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import {
  createPublicClient,
  http,
  type Hash,
  type Address,
  parseUnits,
  parseEther,
  formatUnits,
} from "viem";
import { base } from "viem/chains";
import {
  getCryptoPrices,
  usdToCryptoBigInt,
} from "@repo/shared/utils/crypto-price";
import {
  verifyTransaction,
  isValidTxHash,
  isValidAddress,
} from "@repo/shared/utils/web3-verification";

export interface Vendor {
  id: string;
  name: string;
  address: string | null;
  slug: string;
  category: string;
  rating: number;
  image: string;
  distance?: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
}

const logger = new Logger({ serviceName: "open-delivery-customer-actions" });

export async function getRealVendors(
  userLat?: number,
  userLng?: number,
): Promise<Vendor[]> {
  try {
    if (!userLat || !userLng) {
      // Return empty list if no location provided (no fallback to SF)
      return [];
    }

    // 0.7 degrees is roughly 50 miles / 80 kilometers
    const RADIUS_LIMIT = 0.7;

    // Use PostgreSQL to calculate distance and sort by proximity
    // Distance = sqrt( (lat2-lat1)^2 + (lng2-lng1)^2 )
    // lat/lng are now numeric columns (precision 10, scale 7) - no casting needed
    const data = await getDb().execute(sql`
      SELECT id, name, address, slug, lat, lng,
        sqrt(
          pow(lat::double precision - ${userLat}::double precision, 2) +
          pow(lng::double precision - ${userLng}::double precision, 2)
        ) as distance
      FROM restaurants
      WHERE is_shadow = false
        AND is_claimed = true
        -- Filter out restaurants with invalid coordinates
        AND lat IS NOT NULL
        AND lng IS NOT NULL
        -- Hard radius limit: only show restaurants within ~50 miles
        AND lat::double precision BETWEEN ${userLat - RADIUS_LIMIT}::double precision AND ${userLat + RADIUS_LIMIT}::double precision
        AND lng::double precision BETWEEN ${userLng - RADIUS_LIMIT}::double precision AND ${userLng + RADIUS_LIMIT}::double precision
      ORDER BY distance ASC
      LIMIT 20
    `);

    return data.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      address: r.address || "Address unavailable",
      slug: r.slug,
      category: "Restaurant",
      rating: 4.5,
      image: "🍽️",
      distance: parseFloat(r.distance) || undefined,
    }));
  } catch (error) {
    logger.error("Failed to fetch vendors", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Could not load restaurants");
  }
}

export async function getMenu(restaurantId: string): Promise<MenuItem[]> {
  try {
    const products = await getDb()
      .select()
      .from(restaurantProducts)
      .where(eq(restaurantProducts.restaurantId, restaurantId));

    return products.map((p: typeof restaurantProducts.$inferSelect) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      category: p.category,
    }));
  } catch (error) {
    logger.error("Failed to fetch menu", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Could not load menu items");
  }
}

/**
 * Get Restaurant Wallet Address
 *
 * Fetches the crypto wallet address for a restaurant to enable direct payments.
 */
export async function getRestaurantWallet(restaurantId: string): Promise<{
  success: boolean;
  walletAddress?: string | null;
  error?: string;
}> {
  try {
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
      columns: {
        walletAddress: true,
      },
    });

    if (!restaurant) {
      return {
        success: false,
        error: "Restaurant not found",
      };
    }

    return {
      success: true,
      walletAddress: restaurant.walletAddress,
    };
  } catch (error) {
    logger.error("Failed to fetch restaurant wallet", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch wallet",
    };
  }
}

/**
 * Place a real order with crypto payment verification
 *
 * ZERO-TRUST ARCHITECTURE:
 * - Frontend proposes transaction, backend MUST verify on-chain
 * - Transaction hash is verified before order is confirmed
 * - Payment must match expected amount and recipient
 *
 * @param clientOrderId - Order ID generated by the frontend and signed by the client.
 *   This ensures the EIP-712 signature binds to the correct orderId.
 *   Falls back to a new UUID for non-crypto orders.
 */
export async function placeRealOrder(
  vendorId: string,
  items: Array<{ id: string; name: string; price: number; quantity: number }>,
  deliveryAddress?: string,
  tipAmount: number = 0,
  // Web3 payment parameters
  paymentParams?: {
    txHash: string; // Transaction hash (will be verified on-chain)
    walletAddress: string; // User's wallet address
    paymentCurrency?: string; // Token symbol (USDC, ETH, etc.)
    chainId?: number; // Blockchain chain ID (default: Base)
    restaurantWalletAddress?: string; // Direct payment to restaurant wallet
    signature?: string; // Cryptographic signature of orderId (required for verification)
  },
  clientOrderId?: string, // Order ID generated client-side for signature binding
) {
  const user = await currentUser();

  if (!user) {
    throw new Error("You must be logged in to place an order.");
  }

  const restaurant = await getDb().query.restaurants.findFirst({
    where: sql`${restaurants.id} = ${vendorId}`,
  });

  if (!restaurant) {
    throw new Error("Restaurant not found");
  }

  // Use the client-provided ID (which the signature binds to) or fallback to new UUID
  const orderId = clientOrderId || randomUUID();

  // Validate clientOrderId format if provided to prevent ID spoofing
  if (
    clientOrderId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      clientOrderId,
    )
  ) {
    throw new Error("Invalid order ID format");
  }

  // Convert fiat amounts to crypto smallest units (Wei for ETH, atomic for USDC)
  // CRITICAL: Use integer math (cents) from the start to avoid floating-point precision loss
  const paymentCurrency = paymentParams?.paymentCurrency || "USDC";
  const subtotalCents = items.reduce(
    (sum, item) => sum + Math.round(item.price * 100) * item.quantity,
    0,
  );
  const tipCents = Math.round(Math.max(0, tipAmount) * 100);
  const totalCents = subtotalCents + tipCents;

  let subtotalCrypto: string;
  let tipCrypto: string;
  let totalCrypto: string;

  if (paymentCurrency === "ETH") {
    // Use exact market rate - slippage is checked inside verifyTransaction
    subtotalCrypto = (
      await usdToCryptoBigInt(BigInt(subtotalCents), "ETH")
    ).toString();
    tipCrypto = (await usdToCryptoBigInt(BigInt(tipCents), "ETH")).toString();
    totalCrypto = (
      await usdToCryptoBigInt(BigInt(totalCents), "ETH")
    ).toString();
  } else {
    // USDC: 6 decimals, assume 1 USD = 1 USDC
    // 1 USD = 100 cents. 1 USDC = 1,000,000 atomic units.
    // Multiplier from cents to 6-decimal USDC is 10,000 (10^4).
    totalCrypto = (BigInt(totalCents) * 10000n).toString();
    subtotalCrypto = (BigInt(subtotalCents) * 10000n).toString();
    tipCrypto = (BigInt(tipCents) * 10000n).toString();
  }

  // ============================================================================
  // ZERO-TRUST: Verify on-chain transaction BEFORE inserting order
  // ============================================================================

  if (paymentParams?.txHash) {
    // Validate transaction hash format
    if (!isValidTxHash(paymentParams.txHash)) {
      throw new Error("Invalid transaction hash format");
    }

    // Validate wallet address format
    if (!isValidAddress(paymentParams.walletAddress)) {
      throw new Error("Invalid wallet address format");
    }

    // ============================================================================
    // REPLAY GUARD: Atomically register the txHash to prevent replay attacks
    // This is a TOCTOU-safe check that registers the transaction upfront.
    // If the order creation fails later, we rollback this registration.
    // ============================================================================
    const replayCheck = await isReplayAllowed({
      txHash: paymentParams.txHash as Hash,
      appSource: "open-delivery",
      entityId: orderId,
    });

    if (!replayCheck) {
      throw new Error(
        `Payment transaction ${paymentParams.txHash.substring(0, 10)}... was already used or blocked.`,
      );
    }

    // Verify transaction on-chain using shared utility
    const slippageBps =
      paymentCurrency === "ETH" ? AppConfig.getSlippageBps() : undefined;
    const verificationResult = await verifyTransaction({
      txHash: paymentParams.txHash as Hash,
      expectedValue: BigInt(totalCrypto),
      walletAddress: paymentParams.walletAddress as Address,
      chainId: paymentParams.chainId,
      expectedRecipient: paymentParams.restaurantWalletAddress as
        | Address
        | undefined,
      paymentCurrency,
      orderId, // Required for signature verification
      signature: paymentParams.signature as `0x${string}` | undefined,
      appSource: "open-delivery",
      slippageBps,
    });

    if (!verificationResult.success) {
      // COMPENSATING ACTION: Rollback the replay guard registration
      // so the user can retry with this valid txHash
      await rollbackReplayGuard(paymentParams.txHash as Hash);
      throw new Error(
        `Payment verification failed: ${verificationResult.error}`,
      );
    }

    logger.info(`[Order ${orderId}] Payment verified on-chain`, {
      txHash: paymentParams.txHash,
      confirmations: verificationResult.receipt?.confirmations,
      blockNumber: verificationResult.receipt?.blockNumber.toString(),
    });
  }

  try {
    // ========================================================================
    // ATOMIC TRANSACTION: All database writes are wrapped in a single
    // transaction to ensure ACID guarantees. If the outbox event fails to
    // write, the entire order rolls back, allowing the user to safely retry
    // using their validated Web3 txHash.
    // ========================================================================

    const address = deliveryAddress;
    if (!address) {
      throw new Error(
        "No delivery address provided. A delivery address is required.",
      );
    }

    const db = getDb();

    const result = await db.transaction(async (tx) => {
      // 1. Upsert user
      const userName =
        `${user.firstName || "User"} ${user.lastName || ""}`.trim();
      await tx
        .insert(users)
        .values({
          clerkId: user.id,
          email: user.emailAddresses[0].emailAddress,
          name: userName,
          role: "shopper",
        })
        .onConflictDoUpdate({
          target: users.clerkId,
          set: {
            email: user.emailAddresses[0].emailAddress,
            name: userName,
            updatedAt: new Date(),
          },
        });

      // 2. Fetch the user ID (needed for order insertion)
      const fetchedUser = await tx.query.users.findFirst({
        where: eq(users.clerkId, user.id),
        columns: { id: true },
      });

      if (!fetchedUser) {
        throw new Error("Failed to resolve user record after upsert.");
      }

      // 3. Insert order
      await tx.insert(orders).values({
        id: orderId,
        userId: fetchedUser.id,
        storeId: vendorId,
        status: "pending_verification",
        subtotal: subtotalCrypto,
        tip: tipCrypto,
        total: totalCrypto,
        deliveryAddress: address,
        pickupAddress: restaurant.address || "Restaurant Location",
        paymentTxHash: paymentParams?.txHash || null,
        walletAddress: paymentParams?.walletAddress || null,
        paymentCurrency: paymentCurrency,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 4. Insert order items
      if (items.length > 0) {
        await tx.insert(orderItems).values(
          items.map((item) => ({
            orderId,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            createdAt: new Date(),
          })),
        );
      }

      // 5. Write outbox event (MUST succeed for dispatch to work)
      await tx.insert(outbox).values({
        eventType: "WORKFLOW_STATE_CHANGED",
        payload: {
          executionId: orderId,
          timestamp: new Date().toISOString(),
          eventType: "delivery.intent_created",
          channel: "nervous-system:updates",
          data: {
            orderId: orderId,
            fulfillmentId: orderId,
            pickupAddress: address,
            deliveryAddress: address,
            price: totalCrypto,
            priority: "standard",
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              price: item.price,
            })),
            payment: {
              txHash: paymentParams?.txHash,
              currency: paymentCurrency,
              walletAddress: paymentParams?.walletAddress,
            },
          },
        },
        status: "pending",
        createdAt: new Date(),
      });

      return fetchedUser;
    });

    // Trigger the outbox relay AFTER the transaction commits.
    // Wrapped in after() to guarantee execution outside the request lifecycle.
    after(() => {
      OutboxRelayService.triggerRelay(orderId).catch((err) => {
        logger.error(`[Order ${orderId}] Outbox relay trigger failed`, {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    revalidatePath("/customer");

    return {
      success: true,
      orderId,
      status: "pending" as const,
      payment: {
        txHash: paymentParams?.txHash,
        currency: paymentCurrency,
        verified: !!paymentParams?.txHash,
      },
    };
  } catch (error) {
    // ========================================================================
    // COMPENSATING ACTION: The DB transaction rolled back, but the replay guard
    // registration (isReplayAllowed) was committed BEFORE the transaction.
    // Since funds were captured by the escrow contract, we MUST NOT rollback
    // the replay guard. Instead, route to a DLQ for manual reconciliation.
    // ========================================================================
    if (paymentParams?.txHash) {
      logger.error(
        `CRITICAL: Order creation failed but payment ${paymentParams.txHash} may have been captured. Routing to manual reconciliation.`,
        {
          txHash: paymentParams.txHash,
          orderId,
          customerEmail: user.emailAddresses[0].emailAddress,
          vendorId,
          amount: totalCrypto,
          currency: paymentCurrency,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // Push to Redis DLQ for admin reconciliation dashboard
      const redis = getRedisClient(ServiceNamespace.OD);
      await redis.lpush(
        "dlq:orphaned_payments",
        JSON.stringify({
          txHash: paymentParams.txHash,
          orderId,
          customerEmail: user.emailAddresses[0].emailAddress,
          vendorId,
          amount: totalCrypto,
          currency: paymentCurrency,
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    logger.error("Order placement failed", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to place order. Please try again.");
  }
}
