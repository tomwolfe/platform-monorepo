/**
 * Crypto Checkout Integration Tests
 *
 * End-to-end tests for the Web3 checkout flow
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CryptoCheckout } from "../CryptoCheckout";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Web3Provider } from "../Web3Provider";

// Mock @repo/database to avoid bridge schema initialization
// Provide minimal drizzle table definitions with Zod column shapes
vi.mock("@repo/database", async () => {
  const { z } = await import("zod");

  // Mock column schema that drizzle-zod expects
  const mockPgColumn = (name: string, schema: any) => ({
    name,
    get nameCamelCase() {
      return name;
    },
    primary: false,
    notNull: false,
    _zodType: schema,
  });

  // Mock table definitions with shapes that drizzle-zod expects (Zod schemas)
  const createMockTable = (tableName: string, shape: Record<string, any>) => ({
    name: tableName,
    schema: "public",
    get shape() {
      return shape;
    },
    $inferInsert: {} as any,
    $inferSelect: {} as any,
  });

  const commonColumns = {
    id: mockPgColumn("id", z.string().uuid()),
    createdAt: mockPgColumn("createdAt", z.date()),
    updatedAt: mockPgColumn("updatedAt", z.date()),
  };

  return {
    getDb: vi.fn(),
    restaurants: createMockTable("restaurants", {
      ...commonColumns,
      name: mockPgColumn("name", z.string()),
      slug: mockPgColumn("slug", z.string()),
      ownerEmail: mockPgColumn("ownerEmail", z.string()),
      ownerId: mockPgColumn("ownerId", z.string()),
      apiKey: mockPgColumn("apiKey", z.string()),
      timezone: mockPgColumn("timezone", z.string()),
      openingTime: mockPgColumn("openingTime", z.string()),
      closingTime: mockPgColumn("closingTime", z.string()),
      daysOpen: mockPgColumn("daysOpen", z.string()),
    }),
    restaurantTables: createMockTable("restaurant_tables", {
      ...commonColumns,
      restaurantId: mockPgColumn("restaurantId", z.string()),
      tableNumber: mockPgColumn("tableNumber", z.string()),
      minCapacity: mockPgColumn("minCapacity", z.number()),
      maxCapacity: mockPgColumn("maxCapacity", z.number()),
      status: mockPgColumn("status", z.string()),
      xPos: mockPgColumn("xPos", z.number()),
      yPos: mockPgColumn("yPos", z.number()),
      tableType: mockPgColumn("tableType", z.string()),
    }),
    restaurantReservations: createMockTable("restaurant_reservations", {
      ...commonColumns,
      restaurantId: mockPgColumn("restaurantId", z.string()),
      tableId: mockPgColumn("tableId", z.string()),
      guestName: mockPgColumn("guestName", z.string()),
      guestEmail: mockPgColumn("guestEmail", z.string()),
      partySize: mockPgColumn("partySize", z.number()),
      startTime: mockPgColumn("startTime", z.date()),
      endTime: mockPgColumn("endTime", z.date()),
      status: mockPgColumn("status", z.string()),
      verificationToken: mockPgColumn("verificationToken", z.string()),
      isVerified: mockPgColumn("isVerified", z.boolean()),
    }),
    restaurantWaitlist: createMockTable("restaurant_waitlist", {
      ...commonColumns,
      restaurantId: mockPgColumn("restaurantId", z.string()),
      guestName: mockPgColumn("guestName", z.string()),
      guestEmail: mockPgColumn("guestEmail", z.string()),
      partySize: mockPgColumn("partySize", z.number()),
      status: mockPgColumn("status", z.string()),
    }),
    restaurantProducts: createMockTable("restaurant_products", {
      ...commonColumns,
      restaurantId: mockPgColumn("restaurantId", z.string()),
      name: mockPgColumn("name", z.string()),
      price: mockPgColumn("price", z.number()),
      description: mockPgColumn("description", z.string()),
    }),
    inventoryLevels: createMockTable("inventory_levels", {
      ...commonColumns,
      productId: mockPgColumn("productId", z.string()),
      quantity: mockPgColumn("quantity", z.number()),
    }),
    guestProfiles: createMockTable("guest_profiles", {
      ...commonColumns,
      guestName: mockPgColumn("guestName", z.string()),
      guestEmail: mockPgColumn("guestEmail", z.string()),
      preferences: mockPgColumn("preferences", z.string().optional()),
    }),
    eq: vi.fn(),
  };
});

// Mock wagmi hooks - MUST come before imports
vi.mock("wagmi", async () => {
  const actual = await vi.importActual("wagmi");
  return {
    ...(actual as any),
    useAccount: vi.fn(() => ({
      address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
      isConnected: true,
      chain: { id: 8453, name: "Base" },
    })),
    useSendTransaction: vi.fn(() => ({
      data: null,
      sendTransaction: vi.fn(),
      error: null,
      status: "idle",
    })),
    useWaitForTransactionReceipt: vi.fn(() => ({
      isLoading: false,
      isSuccess: false,
      data: null,
      error: null,
    })),
    useBalance: vi.fn(() => ({
      data: {
        value: BigInt("1000000000000000000"), // 1 ETH
        decimals: 18,
        symbol: "ETH",
      },
    })),
    useSignMessage: vi.fn(() => ({
      signMessage: vi.fn(),
      data: null,
      error: null,
      isPending: false,
    })),
    useWriteContract: vi.fn(() => ({
      writeContract: vi.fn(),
      data: null,
      error: null,
      isPending: false,
    })),
    useReadContract: vi.fn(() => ({
      data: null,
      error: null,
      isLoading: false,
    })),
  };
});

// Mock viem
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...(actual as any),
    formatUnits: vi.fn((value, decimals) => {
      return String(BigInt(value) / BigInt(Math.pow(10, decimals)));
    }),
    parseUnits: vi.fn((value, decimals) => {
      return BigInt(parseFloat(value) * Math.pow(10, decimals));
    }),
    stringToHex: vi.fn((str) => {
      return `0x${Buffer.from(str, "utf-8").toString("hex")}`;
    }),
  };
});

// Mock ERC20 ABI
vi.mock("@repo/shared/utils/erc20-abi", () => ({
  ERC20_ABI: [],
}));

const createTestWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <Web3Provider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Web3Provider>
  );
};

// Shared test data
const mockCart = [
  { id: "1", name: "Burger", price: 10.0, quantity: 2 },
  { id: "2", name: "Fries", price: 5.0, quantity: 1 },
];

const mockProps = {
  cart: mockCart,
  tip: 5.0,
  deliveryAddress: "123 Main St",
  selectedVendor: { id: "vendor-1", name: "Test Restaurant" },
  onCheckoutComplete: vi.fn(),
  onError: vi.fn(),
  onCancel: vi.fn(),
};

describe("CryptoCheckout Integration", () => {
  beforeEach(() => {
    // Don't clear all mocks - we need to preserve Web3Provider
    vi.restoreAllMocks();
  });

  it("should display order summary with correct totals", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    expect(() => screen.getByText("Crypto Payment")).not.toThrow();
    expect(() => screen.getByText("$25.00")).not.toThrow(); // Subtotal
    expect(() => screen.getByText("$5.00")).not.toThrow(); // Tip
    expect(() => screen.getByText("$30.00")).not.toThrow(); // Total
  });

  it("should show USDC equivalent amounts", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    expect(() => screen.getByText("25000000 USDC")).not.toThrow();
    expect(() => screen.getByText("5000000 USDC")).not.toThrow();
    expect(() => screen.getByText("≈ 30000000 USDC")).not.toThrow();
  });

  it("should display wallet balance", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    expect(() => screen.getByText("Wallet Balance")).not.toThrow();
    expect(() => screen.getByText("1.0000 ETH")).not.toThrow();
  });

  it("should show sufficient balance indicator when balance > total", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    // Should show green success state
    const balanceElement = screen.getByText("Wallet Balance").closest("div");
    expect(balanceElement).toHaveClass("bg-green-50");
  });

  it("should show insufficient balance warning when balance < total", async () => {
    const lowBalanceProps = {
      ...mockProps,
      tip: 999999.0, // Make total exceed balance
    };

    render(<CryptoCheckout {...lowBalanceProps} />, {
      wrapper: createTestWrapper(),
    });

    // Should show red warning state
    const balanceElement = screen.getByText("Wallet Balance").closest("div");
    expect(balanceElement).toHaveClass("bg-red-50");
  });

  it("should disable pay button when balance is insufficient", () => {
    const lowBalanceProps = {
      ...mockProps,
      tip: 999999.0,
    };

    render(<CryptoCheckout {...lowBalanceProps} />, {
      wrapper: createTestWrapper(),
    });

    const payButton = screen.getByText("Pay with Crypto").closest("button");
    expect(payButton).toBeDisabled();
  });

  it("should call onCheckoutComplete when payment succeeds", async () => {
    // Mock successful transaction
    vi.mocked(
      await import("wagmi"),
    ).useWaitForTransactionReceipt.mockReturnValue({
      isLoading: false,
      isSuccess: true,
      data: {
        transactionHash:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        status: "success",
        blockNumber: BigInt(1000),
      } as any,
      error: null,
    });

    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    const payButton = screen.getByText("Pay with Crypto");
    fireEvent.click(payButton);

    await waitFor(() => {
      expect(mockProps.onCheckoutComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: expect.any(String),
          txHash: expect.any(String),
        }),
      );
    });
  });

  it("should call onError when transaction fails", async () => {
    // Mock failed transaction
    vi.mocked(await import("wagmi")).useSendTransaction.mockReturnValue({
      data: null,
      sendTransaction: vi.fn(),
      error: new Error("Transaction failed"),
      status: "error",
    } as any);

    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    const payButton = screen.getByText("Pay with Crypto");
    fireEvent.click(payButton);

    await waitFor(() => {
      expect(mockProps.onError).toHaveBeenCalledWith("Transaction failed");
    });
  });

  it("should display security badge", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    expect(() => screen.getByText("Secure On-Chain Payment")).not.toThrow();
  });

  it("should display payment flow steps", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    // Initial state should show review step
    expect(() => screen.getByText("Pay with Crypto")).not.toThrow();
  });

  it("should call onCancel when user cancels", () => {
    render(<CryptoCheckout {...mockProps} />, {
      wrapper: createTestWrapper(),
    });

    const cancelButton = screen.getByText("Continue Shopping");
    fireEvent.click(cancelButton);

    expect(mockProps.onCancel).toHaveBeenCalled();
  });
});

describe("CryptoCheckout Edge Cases", () => {
  it("should handle empty cart gracefully", () => {
    const emptyCartProps = {
      cart: [],
      tip: 0,
      deliveryAddress: "123 Main St",
      selectedVendor: null,
      onCheckoutComplete: vi.fn(),
      onError: vi.fn(),
      onCancel: vi.fn(),
    };

    expect(() => {
      render(<CryptoCheckout {...emptyCartProps} />, {
        wrapper: createTestWrapper(),
      });
    }).not.toThrow();
  });

  it("should handle zero tip", () => {
    const zeroTipProps = {
      ...mockProps,
      tip: 0,
    };

    render(<CryptoCheckout {...zeroTipProps} />, {
      wrapper: createTestWrapper(),
    });

    expect(() => screen.getByText("$0.00")).not.toThrow();
  });

  it("should handle very large amounts", () => {
    const largeAmountProps = {
      ...mockProps,
      cart: [{ id: "1", name: "Luxury Item", price: 999999.99, quantity: 10 }],
      tip: 10000,
    };

    render(<CryptoCheckout {...largeAmountProps} />, {
      wrapper: createTestWrapper(),
    });

    // Should not crash with large numbers
    expect(() => screen.getByText("Crypto Payment")).not.toThrow();
  });
});
