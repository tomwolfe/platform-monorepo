/**
 * Unit Tests: Web3 Checkout Verification
 *
 * Tests for apps/table-stack/src/lib/services/checkout/web3-verify.ts
 *
 * Coverage Targets:
 * - verifyOnChainTransaction: success path, escrow mode, direct payment
 * - Insufficient confirmations handling
 * - Reverted transaction handling
 * - Wrong recipient detection
 * - Invalid hex input handling
 * - verifyTransactionData: reservation ID matching
 * - validateTransactionHash: format validation
 *
 * @see Audit Roadmap: Priority 1 - Financial Transaction Robustness
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// MOCKS - MUST BE BEFORE ANY IMPORTS
// ============================================================================

const mockGetTransaction = vi.fn();
const mockVerifyTransaction = vi.fn();
const mockIsValidTxHash = vi.fn();
const mockGetPublicClient = vi.fn();
const mockRollbackReplayGuard = vi.fn();
const mockHexToString = vi.fn();
const mockIsEscrowMode = vi.fn();
const mockGetEscrowContractAddress = vi.fn();
const mockGetSlippageBps = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...(actual as object),
    hexToString: mockHexToString,
  };
});

vi.mock("@repo/web3", () => ({
  getPublicClient: mockGetPublicClient,
}));

vi.mock("@repo/shared/utils/web3-verification", () => ({
  verifyTransaction: mockVerifyTransaction,
  isValidTxHash: mockIsValidTxHash,
}));

vi.mock("@repo/shared/middleware/web3-replay-guard", () => ({
  rollbackReplayGuard: mockRollbackReplayGuard,
}));

vi.mock("@repo/shared", () => ({
  AppConfig: {
    isEscrowMode: mockIsEscrowMode,
    getEscrowContractAddress: mockGetEscrowContractAddress,
    getSlippageBps: mockGetSlippageBps,
  },
  Logger: class MockLogger {
    private serviceName: string;
    constructor(opts: { serviceName: string }) {
      this.serviceName = opts.serviceName;
    }
    info() {}
    warn() {}
    error() {}
    debug() {}
    fatal() {}
    child() {
      return this;
    }
  },
}));

// Import after mocking
import {
  verifyOnChainTransaction,
  verifyTransactionData,
  validateTransactionHash,
} from "../web3-verify";
import { CheckoutError } from "../validation";

// ============================================================================
// TEST HELPERS
// ============================================================================

const VALID_TX_HASH =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const MOCK_RECIPIENT =
  "0xRestaurantWalletAddress123456789012345678" as `0x${string}`;
const MOCK_ESCROW_ADDRESS =
  "0xEscrowContractAddress12345678901234567890" as `0x${string}`;
const MOCK_RESERVATION_ID = "res-abc-123";

function createMockVerifyResult(overrides?: Partial<any>) {
  return {
    success: true,
    receipt: {
      status: "success",
      blockNumber: BigInt(1000000),
      from: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      to: MOCK_RECIPIENT,
      value: BigInt("1000000000000000000"),
    },
    confirmations: 3,
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("web3-verify: validateTransactionHash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should accept valid transaction hash format", () => {
    mockIsValidTxHash.mockReturnValue(true);

    expect(() => validateTransactionHash(VALID_TX_HASH)).not.toThrow();
    expect(mockIsValidTxHash).toHaveBeenCalledWith(VALID_TX_HASH);
  });

  it("should reject malformed hex input", () => {
    mockIsValidTxHash.mockReturnValue(false);

    expect(() => validateTransactionHash("not-a-valid-hash")).toThrow(
      CheckoutError,
    );

    expect(() => validateTransactionHash("not-a-valid-hash")).toThrow(
      "Invalid transaction hash format",
    );
  });

  it("should reject hash missing 0x prefix", () => {
    mockIsValidTxHash.mockReturnValue(false);

    expect(() =>
      validateTransactionHash(
        "1234567890123456789012345678901234567890123456789012345678901234",
      ),
    ).toThrow(CheckoutError);
  });

  it("should reject hash with wrong length", () => {
    mockIsValidTxHash.mockReturnValue(false);

    expect(() => validateTransactionHash("0x1234")).toThrow(CheckoutError);
  });
});

describe("web3-verify: verifyOnChainTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEscrowMode.mockReturnValue(false);
    mockGetSlippageBps.mockReturnValue(50); // 0.5%
  });

  it("should verify a valid direct payment transaction", async () => {
    mockVerifyTransaction.mockResolvedValue(createMockVerifyResult());

    const result = await verifyOnChainTransaction({
      txHash: VALID_TX_HASH,
      expectedValue: BigInt("1000000000000000000"),
      reservation: {
        restaurant: { walletAddress: MOCK_RECIPIENT },
      },
      paymentCurrency: "ETH",
      targetReservationId: MOCK_RESERVATION_ID,
    });

    expect(result.success).toBe(true);
    expect(mockVerifyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: VALID_TX_HASH,
        expectedRecipient: MOCK_RECIPIENT,
        paymentCurrency: "ETH",
        orderId: MOCK_RESERVATION_ID,
        isEscrowPayment: false,
        slippageBps: 50,
      }),
    );
  });

  it("should use escrow contract address when escrow mode is enabled", async () => {
    mockIsEscrowMode.mockReturnValue(true);
    mockGetEscrowContractAddress.mockReturnValue(MOCK_ESCROW_ADDRESS);
    mockVerifyTransaction.mockResolvedValue(createMockVerifyResult());

    await verifyOnChainTransaction({
      txHash: VALID_TX_HASH,
      expectedValue: BigInt("10000000"),
      reservation: {
        restaurant: { walletAddress: MOCK_RECIPIENT },
      },
      paymentCurrency: "USDC",
      targetReservationId: MOCK_RESERVATION_ID,
    });

    expect(mockVerifyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRecipient: MOCK_ESCROW_ADDRESS,
        isEscrowPayment: true,
      }),
    );
    // Should NOT include slippage for non-ETH payments
    const callArgs = mockVerifyTransaction.mock.calls[0][0];
    expect(callArgs.slippageBps).toBeUndefined();
  });

  it("should throw CheckoutError when verification fails", async () => {
    mockVerifyTransaction.mockResolvedValue({
      success: false,
      error: "Insufficient confirmations",
    });
    mockRollbackReplayGuard.mockResolvedValue(undefined);

    await expect(
      verifyOnChainTransaction({
        txHash: VALID_TX_HASH,
        expectedValue: BigInt("1000000000000000000"),
        reservation: {
          restaurant: { walletAddress: MOCK_RECIPIENT },
        },
        paymentCurrency: "ETH",
        targetReservationId: MOCK_RESERVATION_ID,
      }),
    ).rejects.toThrow(CheckoutError);

    await expect(
      verifyOnChainTransaction({
        txHash: VALID_TX_HASH,
        expectedValue: BigInt("1000000000000000000"),
        reservation: {
          restaurant: { walletAddress: MOCK_RECIPIENT },
        },
        paymentCurrency: "ETH",
        targetReservationId: MOCK_RESERVATION_ID,
      }),
    ).rejects.toThrow("Insufficient confirmations");

    // Should trigger replay guard rollback
    expect(mockRollbackReplayGuard).toHaveBeenCalledWith(VALID_TX_HASH);
  });

  it("should call verifyTransactionData for ETH payments (non-USDC)", async () => {
    mockVerifyTransaction.mockResolvedValue(createMockVerifyResult());
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0x", // Empty input, should skip data verification
    });

    const result = await verifyOnChainTransaction({
      txHash: VALID_TX_HASH,
      expectedValue: BigInt("1000000000000000000"),
      reservation: {
        restaurant: { walletAddress: MOCK_RECIPIENT },
      },
      paymentCurrency: "ETH",
      targetReservationId: MOCK_RESERVATION_ID,
    });

    expect(result.success).toBe(true);
    // verifyTransactionData should be called for ETH
    expect(mockGetPublicClient).toHaveBeenCalledWith("base");
  });

  it("should NOT call verifyTransactionData for USDC payments", async () => {
    mockVerifyTransaction.mockResolvedValue(createMockVerifyResult());

    const result = await verifyOnChainTransaction({
      txHash: VALID_TX_HASH,
      expectedValue: BigInt("10000000"),
      reservation: {
        restaurant: { walletAddress: MOCK_RECIPIENT },
      },
      paymentCurrency: "USDC",
      targetReservationId: MOCK_RESERVATION_ID,
    });

    expect(result.success).toBe(true);
    // Should NOT call getPublicClient for USDC
    expect(mockGetPublicClient).not.toHaveBeenCalled();
  });
});

describe("web3-verify: verifyOnChainTransaction - Edge Cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEscrowMode.mockReturnValue(false);
    mockGetSlippageBps.mockReturnValue(50);
  });

  describe("insufficient confirmations", () => {
    it("should reject transaction with insufficient confirmations", async () => {
      mockVerifyTransaction.mockResolvedValue({
        success: false,
        error: "Insufficient confirmations: got 1, need 3",
        confirmations: 1,
      });
      mockRollbackReplayGuard.mockResolvedValue(undefined);

      await expect(
        verifyOnChainTransaction({
          txHash: VALID_TX_HASH,
          expectedValue: BigInt("1000000000000000000"),
          reservation: {
            restaurant: { walletAddress: MOCK_RECIPIENT },
          },
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow("Insufficient confirmations");

      expect(mockRollbackReplayGuard).toHaveBeenCalledWith(VALID_TX_HASH);
    });
  });

  describe("reverted transaction", () => {
    it("should reject transaction with reverted status", async () => {
      mockVerifyTransaction.mockResolvedValue({
        success: false,
        error: "Transaction reverted on-chain",
        receipt: { status: "reverted" },
      });
      mockRollbackReplayGuard.mockResolvedValue(undefined);

      await expect(
        verifyOnChainTransaction({
          txHash: VALID_TX_HASH,
          expectedValue: BigInt("1000000000000000000"),
          reservation: {
            restaurant: { walletAddress: MOCK_RECIPIENT },
          },
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow("Transaction reverted on-chain");

      expect(mockRollbackReplayGuard).toHaveBeenCalledWith(VALID_TX_HASH);
    });
  });

  describe("wrong recipient", () => {
    it("should reject transaction sent to wrong recipient", async () => {
      const wrongRecipient = "0xWrongAddress123456789012345678901234567890";
      mockVerifyTransaction.mockResolvedValue({
        success: false,
        error: `Transaction recipient mismatch: expected ${MOCK_RECIPIENT}, got ${wrongRecipient}`,
      });
      mockRollbackReplayGuard.mockResolvedValue(undefined);

      await expect(
        verifyOnChainTransaction({
          txHash: VALID_TX_HASH,
          expectedValue: BigInt("1000000000000000000"),
          reservation: {
            restaurant: { walletAddress: MOCK_RECIPIENT },
          },
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow(/recipient mismatch/);

      expect(mockRollbackReplayGuard).toHaveBeenCalledWith(VALID_TX_HASH);
    });

    it("should handle missing restaurant wallet address", async () => {
      mockVerifyTransaction.mockResolvedValue({
        success: false,
        error: "Transaction recipient mismatch",
      });
      mockRollbackReplayGuard.mockResolvedValue(undefined);

      await expect(
        verifyOnChainTransaction({
          txHash: VALID_TX_HASH,
          expectedValue: BigInt("1000000000000000000"),
          reservation: {
            restaurant: { walletAddress: null },
          },
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow("Transaction recipient mismatch");
    });

    it("should handle missing restaurant object", async () => {
      mockVerifyTransaction.mockResolvedValue({
        success: false,
        error: "Transaction recipient mismatch",
      });
      mockRollbackReplayGuard.mockResolvedValue(undefined);

      await expect(
        verifyOnChainTransaction({
          txHash: VALID_TX_HASH,
          expectedValue: BigInt("1000000000000000000"),
          reservation: {},
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow("Transaction recipient mismatch");
    });
  });

  describe("invalid hex input", () => {
    it("should handle malformed txHash in verifyTransaction", async () => {
      mockVerifyTransaction.mockRejectedValue(
        new Error("Invalid hex string: not-a-valid-hash"),
      );

      await expect(
        verifyOnChainTransaction({
          txHash: "not-a-valid-hash",
          expectedValue: BigInt("1000000000000000000"),
          reservation: {
            restaurant: { walletAddress: MOCK_RECIPIENT },
          },
          paymentCurrency: "ETH",
          targetReservationId: MOCK_RESERVATION_ID,
        }),
      ).rejects.toThrow();
    });
  });
});

describe("web3-verify: verifyTransactionData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should verify matching reservation ID in transaction data", async () => {
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0x7265732d6162632d313233", // hex encoding of "res-abc-123"
    });
    mockHexToString.mockReturnValue("res-abc-123");

    await verifyTransactionData(VALID_TX_HASH, "res-abc-123");

    expect(mockGetPublicClient).toHaveBeenCalledWith("base");
    expect(mockGetTransaction).toHaveBeenCalledWith({
      hash: VALID_TX_HASH,
    });
  });

  it("should throw CheckoutError for mismatched reservation ID", async () => {
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0x77726f6e672d6964", // hex encoding of "wrong-id"
    });
    mockHexToString.mockReturnValue("wrong-id");

    await expect(
      verifyTransactionData(VALID_TX_HASH, "res-abc-123"),
    ).rejects.toThrow(CheckoutError);

    await expect(
      verifyTransactionData(VALID_TX_HASH, "res-abc-123"),
    ).rejects.toThrow("Reservation ID not found in transaction data");
  });

  it("should skip verification for empty transaction input", async () => {
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0x", // Empty input
    });

    // Should not throw
    await verifyTransactionData(VALID_TX_HASH, "res-abc-123");

    expect(mockHexToString).not.toHaveBeenCalled();
  });

  it("should warn but not throw for undecodable transaction data", async () => {
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0xinvalidhex",
    });
    mockHexToString.mockImplementation(() => {
      throw new Error("Invalid hex");
    });

    // Should NOT throw - it just warns and continues
    await expect(
      verifyTransactionData(VALID_TX_HASH, "res-abc-123"),
    ).resolves.not.toThrow();
  });

  it("should re-throw CheckoutError from decode path", async () => {
    mockGetPublicClient.mockReturnValue({
      getTransaction: mockGetTransaction,
    });
    mockGetTransaction.mockResolvedValue({
      input: "0x77726f6e672d6964",
    });
    mockHexToString.mockReturnValue("wrong-id");

    await expect(
      verifyTransactionData(VALID_TX_HASH, "res-abc-123"),
    ).rejects.toThrow(CheckoutError);
  });
});
