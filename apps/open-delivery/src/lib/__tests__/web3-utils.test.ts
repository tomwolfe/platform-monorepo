/**
 * Web3 Utilities Unit Tests
 *
 * Tests for crypto payment helper functions
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  formatTokenAmount,
  parseTokenAmount,
  formatCryptoPrice,
  usdToCrypto,
  getPaymentStatusText,
  TOKEN_DECIMALS,
} from "@repo/shared/utils/web3-verification";

// Mock viem
vi.mock("viem", () => ({
  formatUnits: vi.fn((value, decimals) => {
    return String(BigInt(value) / BigInt(Math.pow(10, decimals)));
  }),
  parseUnits: vi.fn((value, decimals) => {
    return BigInt(parseFloat(value) * Math.pow(10, decimals));
  }),
  createPublicClient: vi.fn(),
  http: vi.fn(),
}));

describe("Web3 Utils", () => {
  describe("TOKEN_DECIMALS", () => {
    it("should have correct decimals for common tokens", () => {
      expect(TOKEN_DECIMALS.ETH).toBe(18);
      expect(TOKEN_DECIMALS.USDC).toBe(6);
      expect(TOKEN_DECIMALS.USDT).toBe(6);
      expect(TOKEN_DECIMALS.DAI).toBe(18);
      expect(TOKEN_DECIMALS.WBTC).toBe(8);
    });
  });

  describe("formatTokenAmount", () => {
    it("should format ETH amount correctly (18 decimals)", () => {
      const result = formatTokenAmount("1000000000000000000", 18); // 1 ETH in Wei
      expect(result).toBe("1");
    });

    it("should format USDC amount correctly (6 decimals)", () => {
      const result = formatTokenAmount("1000000", 6); // 1 USDC
      expect(result).toBe("1");
    });

    it("should format large amounts correctly", () => {
      const result = formatTokenAmount("1000000000000000000000", 18); // 1000 ETH
      expect(result).toBe("1000");
    });

    it("should handle string input", () => {
      const result = formatTokenAmount("500000", 6);
      expect(result).toBe("0.5");
    });

    it("should handle bigint input", () => {
      const result = formatTokenAmount(BigInt("1000000000000000000"), 18);
      expect(result).toBe("1");
    });
  });

  describe("parseTokenAmount", () => {
    it("should parse ETH amount to Wei (18 decimals)", () => {
      const result = parseTokenAmount("1.5", 18);
      expect(result).toBe(BigInt("1500000000000000000"));
    });

    it("should parse USDC amount to atomic units (6 decimals)", () => {
      const result = parseTokenAmount("10.50", 6);
      expect(result).toBe(BigInt("10500000"));
    });

    it("should handle whole numbers", () => {
      const result = parseTokenAmount("100", 6);
      expect(result).toBe(BigInt("100000000"));
    });

    it("should handle small decimals", () => {
      const result = parseTokenAmount("0.001", 6);
      expect(result).toBe(BigInt("1000"));
    });
  });

  describe("formatCryptoPrice", () => {
    it("should format USDC price with $ symbol and 2 decimals", () => {
      const result = formatCryptoPrice("10500000", "USDC");
      expect(result).toBe("$10.50");
    });

    it("should format USDT price with $ symbol and 2 decimals", () => {
      const result = formatCryptoPrice("5000000", "USDT");
      expect(result).toBe("$5.00");
    });

    it("should format ETH price with 6 decimals", () => {
      const result = formatCryptoPrice("1500000000000000", "ETH");
      expect(result).toBe("0.001500 ETH");
    });

    it("should format unknown token with 4 decimals", () => {
      const result = formatCryptoPrice("1000000", "UNKNOWN");
      expect(result).toBe("1.0000 UNKNOWN");
    });

    it("should handle bigint input", () => {
      const result = formatCryptoPrice(BigInt("25000000"), "USDC");
      expect(result).toBe("$25.00");
    });
  });

  describe("usdToCrypto", () => {
    it("should convert USD to USDC (1:1 ratio)", () => {
      const result = usdToCrypto(100, "USDC", 1);
      expect(result).toBe("100000000"); // 100 USDC in atomic units
    });

    it("should convert USD to ETH based on price", () => {
      const result = usdToCrypto(100, "ETH", 2000); // ETH at $2000
      expect(result).toBe("50000000000000000"); // 0.05 ETH in Wei
    });

    it("should handle fractional USD amounts", () => {
      const result = usdToCrypto(10.50, "USDC", 1);
      expect(result).toBe("10500000"); // 10.50 USDC
    });

    it("should handle zero USD amount", () => {
      const result = usdToCrypto(0, "USDC", 1);
      expect(result).toBe("0");
    });
  });

  describe("getPaymentStatusText", () => {
    it("should return correct text for pending status", () => {
      expect(getPaymentStatusText("pending")).toBe("Pending Confirmation");
    });

    it("should return correct text for confirming status", () => {
      expect(getPaymentStatusText("confirming")).toBe("Confirming on Blockchain");
    });

    it("should return correct text for confirmed status", () => {
      expect(getPaymentStatusText("confirmed")).toBe("Payment Confirmed");
    });

    it("should return correct text for completed status", () => {
      expect(getPaymentStatusText("completed")).toBe("Order Placed");
    });

    it("should return correct text for error status", () => {
      expect(getPaymentStatusText("error")).toBe("Payment Failed");
    });

    it("should return input for unknown status", () => {
      expect(getPaymentStatusText("unknown")).toBe("unknown");
    });
  });
});
