"use server";

import { getDb, restaurants, orders, orderItems, users, sql, restaurantProducts, eq, type CryptoAmount } from "@repo/database";
import { currentUser } from "@clerk/nextjs/server";
import { RealtimeService, isReplayAllowed, rollbackReplayGuard } from "@repo/shared";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { createPublicClient, http, type Hash, type Address, parseUnits, parseEther, formatUnits } from "viem";
import { base } from "viem/chains";
import { getCryptoPrices, usdToCryptoBigIntWithSlippage } from "@repo/shared/utils/crypto-price";
import { verifyTransaction, isValidTxHash, isValidAddress } from "@repo/shared/utils/web3-verification";

// Global slippage tolerance for ETH-based payments (2% = 200 basis points)
const SLIPPAGE_BPS = 200;

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

export async function getRealVendors(userLat?: number, userLng?: number): Promise<Vendor[]> {
  try {
    if (!userLat || !userLng) {
      // Return empty list if no location provided (no fallback to SF)
      return [];
    }

    // 0.7 degrees is roughly 50 miles / 80 kilometers
    const RADIUS_LIMIT = 0.7;

    // Use PostgreSQL to calculate distance and sort by proximity
    // Distance = sqrt( (lat2-lat1)^2 + (lng2-lng1)^2 )
    // Use NULLIF to handle empty TEXT coordinates safely
    // Filter by radius to only show nearby restaurants
    const data = await getDb().execute(sql`
      SELECT id, name, address, slug, lat, lng,
        sqrt(
          pow(cast(NULLIF(lat, '') as double precision) - ${userLat}, 2) +
          pow(cast(NULLIF(lng, '') as double precision) - ${userLng}, 2)
        ) as distance
      FROM restaurants
      WHERE is_shadow = false 
        AND is_claimed = true
        -- Filter out restaurants with invalid coordinates
        AND NULLIF(lat, '') IS NOT NULL
        AND NULLIF(lng, '') IS NOT NULL
        -- Hard radius limit: only show restaurants within ~50 miles
        AND cast(NULLIF(lat, '') as double precision) BETWEEN ${userLat - RADIUS_LIMIT} AND ${userLat + RADIUS_LIMIT}
        AND cast(NULLIF(lng, '') as double precision) BETWEEN ${userLng - RADIUS_LIMIT} AND ${userLng + RADIUS_LIMIT}
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
    console.error("Failed to fetch vendors:", error);
    throw new Error("Could not load restaurants");
  }
}

export async function getMenu(restaurantId: string): Promise<MenuItem[]> {
  try {
    const products = await db
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
    console.error("Failed to fetch menu:", error);
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
    console.error("Failed to fetch restaurant wallet:", error);
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
  }
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

  const orderId = randomUUID();

  // Convert fiat amounts to crypto smallest units (Wei for ETH, atomic for USDC)
  // Fetch live ETH price from oracle for accurate conversion
  const paymentCurrency = paymentParams?.paymentCurrency || "USDC";
  const subtotalFiat = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tipFiat = Math.max(0, tipAmount);
  const totalFiat = subtotalFiat + tipFiat;

  let subtotalCrypto: string;
  let tipCrypto: string;
  let totalCrypto: string;

  if (paymentCurrency === "ETH") {
    // Use standardized BigInt conversion with slippage
    const subtotalCents = BigInt(Math.round(subtotalFiat * 100));
    const tipCents = BigInt(Math.round(tipFiat * 100));
    const totalCents = BigInt(Math.round(totalFiat * 100));

    subtotalCrypto = (await usdToCryptoBigIntWithSlippage(subtotalCents, "ETH", SLIPPAGE_BPS)).toString();
    tipCrypto = (await usdToCryptoBigIntWithSlippage(tipCents, "ETH", SLIPPAGE_BPS)).toString();
    totalCrypto = (await usdToCryptoBigIntWithSlippage(totalCents, "ETH", SLIPPAGE_BPS)).toString();
  } else {
    // USDC: 6 decimals, assume 1 USD = 1 USDC
    subtotalCrypto = parseUnits(subtotalFiat.toFixed(6), 6).toString();
    tipCrypto = parseUnits(tipFiat.toFixed(6), 6).toString();
    totalCrypto = parseUnits(totalFiat.toFixed(6), 6).toString();
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
      appSource: 'open-delivery',
      entityId: orderId,
    });

    if (!replayCheck) {
      throw new Error(`Payment transaction ${paymentParams.txHash.substring(0, 10)}... was already used or blocked.`);
    }

    // Verify transaction on-chain using shared utility
    // ETH slippage tolerance is handled via the global SLIPPAGE_BPS constant

    const verificationResult = await verifyTransaction({
      txHash: paymentParams.txHash as Hash,
      expectedValue: BigInt(totalCrypto),
      walletAddress: paymentParams.walletAddress as Address,
      chainId: paymentParams.chainId,
      expectedRecipient: paymentParams.restaurantWalletAddress as Address | undefined,
      paymentCurrency,
      orderId, // Required for signature verification
      signature: paymentParams.signature as `0x${string}` | undefined,
      appSource: "open-delivery",
      slippageBps: paymentCurrency === "ETH" ? SLIPPAGE_BPS : undefined,
    });

    if (!verificationResult.success) {
      // COMPENSATING ACTION: Rollback the replay guard registration
      // so the user can retry with this valid txHash
      await rollbackReplayGuard(paymentParams.txHash as Hash);
      throw new Error(`Payment verification failed: ${verificationResult.error}`);
    }

    console.log(`[Order ${orderId}] Payment verified on-chain:`, {
      txHash: paymentParams.txHash,
      confirmations: verificationResult.receipt?.confirmations,
      blockNumber: verificationResult.receipt?.blockNumber.toString(),
    });
  }

  try {
    // CRITICAL FIX: Wrap order creation in a database transaction
    // This prevents race conditions where the same paymentTxHash could be
    // submitted to multiple orders before the UNIQUE constraint locks it down
    const result = await getDb().transaction(async (tx: typeof db) => {
      let userRecord = await tx
        .select()
        .from(users)
        .where(sql`${users.clerkId} = ${user.id}`)
        .limit(1)
        .then((rows: typeof users.$inferSelect[]) => rows[0]);

      if (!userRecord) {
        const [newUser] = await tx
          .insert(users)
          .values({
            clerkId: user.id,
            email: user.emailAddresses[0].emailAddress,
            name: `${user.firstName || "User"} ${user.lastName || ""}`,
            role: "shopper",
          })
          .returning();
        userRecord = newUser;
      }

      // Use provided delivery address or fallback to user's default
      // Fail explicitly if no address is available (no hardcoded defaults)
      const address = deliveryAddress || userRecord.defaultDeliveryAddress;

      if (!address) {
        throw new Error("No delivery address provided and no default found in profile.");
      }

      // CRITICAL: Check for duplicate payment hash within transaction
      // This prevents replay attacks where the same USDC tx is used for multiple orders
      if (paymentParams?.txHash) {
        const existingOrder = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(sql`${orders.paymentTxHash} = ${paymentParams.txHash}`)
          .limit(1)
          .then((rows: Array<{ id: string }>) => rows[0]);

        if (existingOrder) {
          throw new Error(`Payment transaction ${paymentParams.txHash} already used for order ${existingOrder.id}`);
        }
      }

      const [newOrder] = await tx
        .insert(orders)
        .values({
          id: orderId,
          userId: userRecord?.id,
          storeId: vendorId as any,
          status: "pending_verification",
          subtotal: subtotalCrypto as CryptoAmount,
          tip: tipCrypto as CryptoAmount,
          total: totalCrypto as CryptoAmount,
          deliveryAddress: address,
          pickupAddress: restaurant.address || "Restaurant Location",
          // Web3 payment fields
          paymentTxHash: paymentParams?.txHash || null,
          walletAddress: paymentParams?.walletAddress || null,
          paymentCurrency: paymentCurrency,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      // Insert all order items
      await tx.insert(orderItems).values(
        items.map((item) => ({
          orderId: orderId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          createdAt: new Date(),
        }))
      );

      return newOrder;
    });

    // Publish Ably event AFTER transaction commits (not inside transaction)
    await RealtimeService.publish("nervous-system:updates", "delivery.intent_created", {
      orderId: result.id,
      fulfillmentId: result.id,
      pickupAddress: result.pickupAddress,
      deliveryAddress: result.deliveryAddress,
      price: result.total,
      priority: "standard",
      items: items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
      timestamp: new Date().toISOString(),
      traceId: `order-${orderId}`,
      payment: {
        txHash: paymentParams?.txHash,
        currency: paymentCurrency,
        walletAddress: paymentParams?.walletAddress,
      },
    });

    revalidatePath("/customer");

    return {
      success: true,
      orderId: result.id,
      status: "pending" as const,
      payment: {
        txHash: paymentParams?.txHash,
        currency: paymentCurrency,
        verified: !!paymentParams?.txHash,
      },
    };
  } catch (error) {
    // COMPENSATING ACTION: If the database transaction failed for non-Web3 reasons
    // (e.g., constraint violation, connection error) AFTER the replay guard was
    // triggered, rollback the registration so the user can re-submit.
    if (paymentParams?.txHash && error instanceof Error && !error.message.includes("already used")) {
      await rollbackReplayGuard(paymentParams.txHash as Hash);
    }

    console.error("Order placement failed:", error);
    throw new Error("Failed to place order. Please try again.");
  }
}
