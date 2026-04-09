/**
 * Tests: T1.3 - Payment Mode Configuration
 *
 * Verifies that the PaymentMode enum and AppConfig payment mode getters
 * work correctly, enabling config-driven Web3 payment routing.
 *
 * @see Phase 1, Task 1.3: Web3 Payment Standardization
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PaymentMode, DEFAULT_PAYMENT_MODE } from "../config/web3-chains";

// ============================================================================
// TESTS: PaymentMode Enum
// ============================================================================

describe("T1.3: PaymentMode Enum", () => {
  it("should have DIRECT_P2P variant", () => {
    expect(PaymentMode.DIRECT_P2P).toBe("DIRECT_P2P");
  });

  it("should have ESCROW variant", () => {
    expect(PaymentMode.ESCROW).toBe("ESCROW");
  });

  it("should have DISABLED variant", () => {
    expect(PaymentMode.DISABLED).toBe("DISABLED");
  });

  it("should have exactly 3 variants", () => {
    // String enums have 3 keys (not 6 like numeric enums)
    expect(Object.keys(PaymentMode).length).toBe(3);
    expect(
      Object.values(PaymentMode).filter((v) => typeof v === "string"),
    ).toHaveLength(3);
  });
});

// ============================================================================
// TESTS: Default Payment Mode
// ============================================================================

describe("T1.3: Default Payment Mode", () => {
  it("should default to DIRECT_P2P", () => {
    expect(DEFAULT_PAYMENT_MODE).toBe(PaymentMode.DIRECT_P2P);
  });

  it("should be a valid PaymentMode value", () => {
    expect(Object.values(PaymentMode)).toContain(DEFAULT_PAYMENT_MODE);
  });
});

// ============================================================================
// TESTS: AppConfig Payment Mode Getters
// ============================================================================

describe("T1.3: AppConfig Payment Mode Getters", () => {
  const originalEnv = process.env.PAYMENT_MODE;

  beforeEach(() => {
    // Clear any cached config
    vi.resetModules();
  });

  afterEach(() => {
    process.env.PAYMENT_MODE = originalEnv;
    vi.resetModules();
  });

  it("should default to DIRECT_P2P when PAYMENT_MODE is not set", async () => {
    delete process.env.PAYMENT_MODE;
    const { AppConfig } = await import("../config");
    expect(AppConfig.getAppPaymentMode()).toBe("DIRECT_P2P");
  });

  it("should return ESCROW when PAYMENT_MODE=ESCROW", async () => {
    process.env.PAYMENT_MODE = "ESCROW";
    const { AppConfig } = await import("../config");
    expect(AppConfig.getAppPaymentMode()).toBe("ESCROW");
  });

  it("should return DISABLED when PAYMENT_MODE=DISABLED", async () => {
    process.env.PAYMENT_MODE = "DISABLED";
    const { AppConfig } = await import("../config");
    expect(AppConfig.getAppPaymentMode()).toBe("DISABLED");
  });

  it("should return DIRECT_P2P when PAYMENT_MODE=DIRECT_P2P", async () => {
    process.env.PAYMENT_MODE = "DIRECT_P2P";
    const { AppConfig } = await import("../config");
    expect(AppConfig.getAppPaymentMode()).toBe("DIRECT_P2P");
  });

  it("isEscrowMode() should return true only for ESCROW mode", async () => {
    process.env.PAYMENT_MODE = "ESCROW";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isEscrowMode()).toBe(true);
  });

  it("isEscrowMode() should return false for DIRECT_P2P mode", async () => {
    process.env.PAYMENT_MODE = "DIRECT_P2P";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isEscrowMode()).toBe(false);
  });

  it("isDirectP2PMode() should return true only for DIRECT_P2P mode", async () => {
    process.env.PAYMENT_MODE = "DIRECT_P2P";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isDirectP2PMode()).toBe(true);
  });

  it("isDirectP2PMode() should return false for ESCROW mode", async () => {
    process.env.PAYMENT_MODE = "ESCROW";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isDirectP2PMode()).toBe(false);
  });

  it("isPaymentDisabled() should return true only for DISABLED mode", async () => {
    process.env.PAYMENT_MODE = "DISABLED";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isPaymentDisabled()).toBe(true);
  });

  it("isPaymentDisabled() should return false for DIRECT_P2P mode", async () => {
    process.env.PAYMENT_MODE = "DIRECT_P2P";
    const { AppConfig } = await import("../config");
    expect(AppConfig.isPaymentDisabled()).toBe(false);
  });
});

// ============================================================================
// TESTS: Config Schema Validation
// ============================================================================

describe("T1.3: Config Schema Validation", () => {
  const originalEnv = process.env.PAYMENT_MODE;

  afterEach(() => {
    process.env.PAYMENT_MODE = originalEnv;
    vi.resetModules();
  });

  it("should accept valid PAYMENT_MODE values", async () => {
    for (const mode of ["DIRECT_P2P", "ESCROW", "DISABLED"]) {
      process.env.PAYMENT_MODE = mode;
      vi.resetModules();
      const { AppConfig } = await import("../config");
      expect(AppConfig.getAppPaymentMode()).toBe(mode);
    }
  });
});
