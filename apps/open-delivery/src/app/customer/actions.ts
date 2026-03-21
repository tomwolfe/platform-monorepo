"use server";

import { db, restaurants, orders, orderItems, users, sql, restaurantProducts, eq, type CryptoAmount } from "@repo/database";
import { currentUser } from "@clerk/nextjs/server";
import { RealtimeService } from "@repo/shared";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { createPublicClient, http, type Hash, type Address, parseUnits, formatUnits } from "viem";
import { base } from "viem/chains";
import { getCryptoPrices } from "@repo/shared/utils/crypto-price";

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
    const data = await db.execute(sql`
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
    const restaurant = await db.query.restaurants.findFirst({
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
  }
) {
  const user = await currentUser();

  if (!user) {
    throw new Error("You must be logged in to place an order.");
  }

  const restaurant = await db.query.restaurants.findFirst({
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
    // Fetch live ETH price from CoinGecko (cached in Redis)
    const { ETH: ethPriceUsd } = await getCryptoPrices();
    
    if (ethPriceUsd <= 0) {
      throw new Error("Failed to fetch ETH price from oracle");
    }

    // Convert USD to ETH: ETH amount = USD / price
    const subtotalEth = subtotalFiat / ethPriceUsd;
    const tipEth = tipFiat / ethPriceUsd;
    const totalEth = totalFiat / ethPriceUsd;

    // Convert to Wei (18 decimals)
    subtotalCrypto = parseUnits(subtotalEth.toFixed(18), 18).toString();
    tipCrypto = parseUnits(tipEth.toFixed(18), 18).toString();
    totalCrypto = parseUnits(totalEth.toFixed(18), 18).toString();
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
    
    // Verify transaction on-chain
    const verificationResult = await verifyOnChainTransaction({
      txHash: paymentParams.txHash as Hash,
      expectedValue: BigInt(totalCrypto),
      walletAddress: paymentParams.walletAddress as Address,
      chainId: paymentParams.chainId,
      expectedRecipient: paymentParams.restaurantWalletAddress as Address | undefined,
      paymentCurrency,
    });
    
    if (!verificationResult.success) {
      throw new Error(`Payment verification failed: ${verificationResult.error}`);
    }
    
    console.log(`[Order ${orderId}] Payment verified on-chain:`, {
      txHash: paymentParams.txHash,
      confirmations: verificationResult.receipt?.confirmations,
      blockNumber: verificationResult.receipt?.blockNumber.toString(),
    });
  }

  try {
    let userRecord = await db
      .select()
      .from(users)
      .where(sql`${users.clerkId} = ${user.id}`)
      .limit(1)
      .then((rows: typeof users.$inferSelect[]) => rows[0]);

    if (!userRecord) {
      const [newUser] = await db
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

    const [newOrder] = await db
      .insert(orders)
      .values({
        id: orderId,
        userId: userRecord?.id,
        storeId: vendorId as any,
        status: "pending_verification", // Intermediate state: payment verified, awaiting driver dispatch
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
    await db.insert(orderItems).values(
      items.map((item) => ({
        orderId: orderId,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        createdAt: new Date(),
      }))
    );

    await RealtimeService.publish("nervous-system:updates", "delivery.intent_created", {
      orderId: newOrder.id,
      fulfillmentId: newOrder.id,
      pickupAddress: newOrder.pickupAddress,
      deliveryAddress: newOrder.deliveryAddress,
      price: newOrder.total, // Ensure this matches the key 'price' used in the driver UI
      priority: "standard",
      items: items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
      timestamp: new Date().toISOString(),
      traceId: `order-${orderId}`,
      // Web3 payment info for driver payout
      payment: {
        txHash: paymentParams?.txHash,
        currency: paymentCurrency,
        walletAddress: paymentParams?.walletAddress,
      },
    });

    revalidatePath("/customer");

    return { 
      success: true, 
      orderId: newOrder.id, 
      status: "pending" as const,
      payment: {
        txHash: paymentParams?.txHash,
        currency: paymentCurrency,
        verified: !!paymentParams?.txHash,
      },
    };
  } catch (error) {
    console.error("Order placement failed:", error);
    throw new Error("Failed to place order. Please try again.");
  }
}

// ============================================================================
// TRANSACTION VERIFICATION HELPERS
// Zero-trust verification of on-chain payments
// ============================================================================

/**
 * Verify a transaction on-chain using viem
 */
async function verifyOnChainTransaction(params: {
  txHash: Hash;
  expectedValue: bigint;
  walletAddress: Address;
  chainId?: number;
  expectedRecipient?: Address; // Optional: verify recipient (for direct-to-restaurant payments)
  paymentCurrency?: string; // 'ETH' or 'USDC' (affects verification logic)
}): Promise<{
  success: boolean;
  error?: string;
  receipt?: {
    status: "success" | "reverted";
    blockNumber: bigint;
    confirmations: number;
    from: Address;
    to: Address | null;
    value: bigint;
  };
}> {
  const { txHash, expectedValue, walletAddress, chainId, expectedRecipient, paymentCurrency = 'ETH' } = params;
  
  try {
    // Get RPC URL from environment or use default
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

    const client = createPublicClient({
      transport: http(rpcUrl),
      chain: base,
    });

    // Step 1: Get transaction receipt
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    // Step 2: Check transaction status
    if (receipt.status !== "success") {
      return {
        success: false,
        error: `Transaction failed with status: ${receipt.status}`,
      };
    }

    // Step 3: Verify sender matches wallet address
    if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
      return {
        success: false,
        error: `Transaction sender mismatch. Expected: ${walletAddress}, Got: ${receipt.from}`,
      };
    }

    // Step 4: Get full transaction to verify value
    const transaction = await client.getTransaction({ hash: txHash });

    // ============================================================================
    // CRITICAL FIX: Handle ERC-20 (USDC) vs ETH verification differently
    // ============================================================================
    
    let actualValue: bigint;
    
    if (paymentCurrency === 'USDC' || paymentCurrency === 'USDT') {
      // For ERC-20 tokens, transaction.value is always 0
      // We need to parse the Transfer event logs to get the actual token amount
      const { parseEventLogs } = await import("viem");
      const { ERC20_ABI } = await import("@repo/shared/utils/erc20-abi");
      
      try {
        // Parse event logs to find Transfer events
        const transferLogs = parseEventLogs({
          logs: receipt.logs,
          abi: ERC20_ABI,
          eventName: 'Transfer',
        });
        
        // Find the Transfer event matching our expected recipient
        const treasuryAddress = (process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS || "").toLowerCase() as Address;
        const expectedTo = expectedRecipient ? expectedRecipient.toLowerCase() : treasuryAddress;
        
        const matchingTransfer = transferLogs.find((log: any) => {
          const args = log.args as { from?: Address; to?: Address; value?: bigint };
          return (
            args.to?.toLowerCase() === expectedTo &&
            args.value !== undefined
          );
        });
        
        if (!matchingTransfer) {
          return {
            success: false,
            error: `No Transfer event found for recipient ${expectedTo || 'treasury'}`,
          };
        }
        
        actualValue = (matchingTransfer.args as { value: bigint }).value;
        
        console.log(`[verifyOnChainTransaction] ERC-20 Transfer verified:`, {
          from: (matchingTransfer.args as any).from,
          to: (matchingTransfer.args as any).to,
          value: actualValue.toString(),
        });
      } catch (parseError) {
        return {
          success: false,
          error: `Failed to parse ERC-20 Transfer events: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
        };
      }
    } else {
      // For native ETH, use transaction.value directly
      actualValue = transaction.value;
    }

    // Verify transaction value matches expected amount
    if (actualValue !== expectedValue) {
      return {
        success: false,
        error: `Transaction value mismatch. Expected: ${expectedValue}, Got: ${actualValue}`,
      };
    }
    
    // Step 5: Check confirmations (minimum 3 for Base)
    const minConfirmations = parseInt(process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3", 10);
    const currentBlock = await client.getBlockNumber();
    const confirmations = Number(currentBlock - receipt.blockNumber);
    
    if (confirmations < minConfirmations) {
      return {
        success: false,
        error: `Insufficient confirmations. Required: ${minConfirmations}, Current: ${confirmations}`,
      };
    }
    
    // Step 6: Verify recipient (support direct-to-restaurant or treasury)
    const treasuryAddress = (process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS || "").toLowerCase() as Address;
    const expectedTo = expectedRecipient ? expectedRecipient.toLowerCase() : treasuryAddress;
    
    if (expectedTo && transaction.to && transaction.to.toLowerCase() !== expectedTo) {
      return {
        success: false,
        error: `Transaction recipient mismatch. Expected: ${expectedTo || 'treasury'}, Got: ${transaction.to}`,
      };
    }
    
    return {
      success: true,
      receipt: {
        status: "success",
        blockNumber: receipt.blockNumber,
        confirmations,
        from: receipt.from,
        to: transaction.to,
        value: actualValue,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Transaction verification failed: ${errorMessage}`,
    };
  }
}

/**
 * Validate transaction hash format
 */
function isValidTxHash(hash: string): boolean {
  // Ethereum transaction hash: 0x followed by 64 hex characters
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

/**
 * Validate Ethereum address format
 */
function isValidAddress(address: string): boolean {
  // Ethereum address: 0x followed by 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
