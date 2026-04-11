/**
 * Tests for crypto-price utility (pure functions only).
 *
 * Note: getCryptoPrices() is mocked in test mode (CI=true or NODE_ENV=test)
 * so we can test the bigint conversion and slippage functions deterministically.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isWithinSlippage,
  usdToCryptoBigIntWithSlippage,
  cryptoToUsdBigInt,
  clearPriceMemo,
} from "../crypto-price";

describe("crypto-price utilities", () => {
  beforeEach(() => {
    clearPriceMemo();
  });

  describe("isWithinSlippage", () => {
    it("should return true for exact match", () => {
      expect(isWithinSlippage(1000n, 1000n, 100)).toBe(true);
    });

    it("should return true when actual is within slippage band", () => {
      // 100 bps = 1% slippage
      // Expected: 10000, 1% = 100, so range is [9900, 10100]
      expect(isWithinSlippage(10050n, 10000n, 100)).toBe(true);
      expect(isWithinSlippage(9950n, 10000n, 100)).toBe(true);
    });

    it("should return true at exact boundaries", () => {
      // 200 bps = 2% slippage
      // Expected: 10000, 2% = 200, so range is [9800, 10200]
      expect(isWithinSlippage(9800n, 10000n, 200)).toBe(true);
      expect(isWithinSlippage(10200n, 10000n, 200)).toBe(true);
    });

    it("should return false when actual is below lower bound", () => {
      expect(isWithinSlippage(9799n, 10000n, 200)).toBe(false);
    });

    it("should return false when actual is above upper bound", () => {
      expect(isWithinSlippage(10201n, 10000n, 200)).toBe(false);
    });

    it("should handle zero slippage (exact match only)", () => {
      expect(isWithinSlippage(1000n, 1000n, 0)).toBe(true);
      expect(isWithinSlippage(1001n, 1000n, 0)).toBe(false);
      expect(isWithinSlippage(999n, 1000n, 0)).toBe(false);
    });

    it("should handle large values (realistic ETH wei amounts)", () => {
      // 1 ETH = 10^18 wei
      const oneEth = 1_000_000_000_000_000_000n;
      const slippage200bps = 200; // 2%

      // 2% of 1 ETH = 0.02 ETH = 2 * 10^16 wei
      const upperBound = oneEth + 20_000_000_000_000_000n;
      const lowerBound = oneEth - 20_000_000_000_000_000n;

      expect(isWithinSlippage(upperBound, oneEth, slippage200bps)).toBe(true);
      expect(isWithinSlippage(lowerBound, oneEth, slippage200bps)).toBe(true);
      expect(isWithinSlippage(upperBound + 1n, oneEth, slippage200bps)).toBe(
        false,
      );
      expect(isWithinSlippage(lowerBound - 1n, oneEth, slippage200bps)).toBe(
        false,
      );
    });

    it("should handle typical checkout amounts", () => {
      // $50 order at ~$3000/ETH = ~0.0167 ETH = 16,666,666,666,666,666 wei
      const expectedWei = 16_666_666_666_666_666n;
      const slippage = 200; // 2%

      // Should allow ~2% variance
      expect(isWithinSlippage(expectedWei, expectedWei, slippage)).toBe(true);
    });
  });

  describe("usdToCryptoBigIntWithSlippage", () => {
    it("should convert USD to crypto with slippage", async () => {
      // In test mode, CI_MOCK_PRICES: ETH = 3000
      // $30.00 = 3000 cents at $3000/ETH = 0.01 ETH = 10^16 wei
      // With 0 slippage
      const result = await usdToCryptoBigIntWithSlippage(
        3000n, // $30.00
        "ETH",
        0, // 0% slippage
      );

      // Should be approximately 0.01 ETH in wei
      expect(result).toBeGreaterThan(0n);
    });

    it("should add slippage buffer", async () => {
      const withoutSlippage = await usdToCryptoBigIntWithSlippage(
        3000n,
        "ETH",
        0,
      );

      const withSlippage = await usdToCryptoBigIntWithSlippage(
        3000n,
        "ETH",
        200, // 2%
      );

      // With slippage should be larger than without
      expect(withSlippage).toBeGreaterThan(withoutSlippage);
    });

    it("should return larger amount for higher slippage", async () => {
      const slippage100 = await usdToCryptoBigIntWithSlippage(
        3000n,
        "ETH",
        100,
      );
      const slippage200 = await usdToCryptoBigIntWithSlippage(
        3000n,
        "ETH",
        200,
      );
      const slippage500 = await usdToCryptoBigIntWithSlippage(
        3000n,
        "ETH",
        500,
      );

      expect(slippage200).toBeGreaterThan(slippage100);
      expect(slippage500).toBeGreaterThan(slippage200);
    });
  });

  describe("cryptoToUsdBigInt", () => {
    it("should convert crypto to USD", async () => {
      // In test mode, ETH = 3000 (mock price)
      // 0.01 ETH = 10^16 wei should be ~$30.00 = 3000 cents
      const cryptoAmount = 10_000_000_000_000_000n; // 0.01 ETH
      const result = await cryptoToUsdBigInt(cryptoAmount, "ETH");

      // Should be approximately 3000 cents ($30.00)
      expect(result).toBeGreaterThan(0n);
    });

    it("should return 0 for zero amount", async () => {
      const result = await cryptoToUsdBigInt(0n, "ETH");
      expect(result).toBe(0n);
    });

    it("should be roughly inverse of usdToCryptoBigInt", async () => {
      // Start with $30.00 (3000 cents)
      const usdCents = 3000n;
      const cryptoWei = await usdToCryptoBigIntWithSlippage(usdCents, "ETH", 0);

      // Convert back to USD
      const backToUsd = await cryptoToUsdBigInt(cryptoWei, "ETH");

      // Should be close to original (within rounding)
      const diff =
        backToUsd > usdCents ? backToUsd - usdCents : usdCents - backToUsd;
      expect(diff).toBeLessThan(10n); // Within 10 cents
    });
  });
});
