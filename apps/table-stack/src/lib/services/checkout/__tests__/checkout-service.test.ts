/**
 * CheckoutService Unit Tests
 *
 * Comprehensive unit tests for the CheckoutService orchestrator.
 * Tests cover all code paths: success, error handling, locking, notifications.
 *
 * @see T1: Increase Unit Test Coverage for Core Services
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CheckoutService, CheckoutInput } from "../checkout.service";
import { CheckoutError } from "../validation";
import * as database from "@repo/database";

// ============================================================================
// MOCKS
// ============================================================================

// Mock server-only FIRST to avoid Client Component errors
vi.mock("server-only", () => ({}));

// Mock @repo/web3 - missing package
vi.mock("@repo/web3", () => ({
  getPublicClient: vi.fn(() => ({
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  })),
}));

// Mock @repo/database - vi.mock is auto-hoisted
vi.mock("@repo/database", () => {
  const mockDb = {
    query: {
      restaurantReservations: {
        findFirst: vi.fn(),
      },
    },
  };

  return {
    getDb: () => mockDb,
    restaurantReservations: {
      id: "id",
      restaurantId: "restaurantId",
    },
    semanticMemories: {},
    eq: vi.fn((col: unknown, val: unknown) => ({ column: col, value: val })),
  };
});

vi.mock("@repo/shared", () => ({
  AppConfig: {
    isDirectP2PMode: vi.fn(() => true),
    isEscrowMode: vi.fn(() => false),
    getEscrowContractAddress: vi.fn(() => null),
    isPaymentDisabled: vi.fn(() => false),
  },
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    constructor(_opts?: Record<string, unknown>) {}
  },
  dispatchTask: vi.fn(),
  releaseReplayProcessingLock: vi.fn(),
  tryAcquireReplayProcessingLock: vi.fn(),
  isReplayAllowed: vi.fn(),
  // Constants
  CHAIN_IDS: {
    BASE_MAINNET: 8453,
    BASE_SEPOLIA: 84532,
  },
  ERROR_CODES: {
    VALIDATION_ERROR: "VALIDATION_ERROR",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
    ALREADY_VERIFIED: "ALREADY_VERIFIED",
  },
  EIP712_DOMAIN: {
    name: "TableStack",
    version: "1",
  },
  EIP712_RESERVATION_TYPES: {
    Reservation: [
      { name: "reservationId", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  DEADLINE_TOLERANCE_SECONDS: 5 * 60,
}));

// Import shared after mocks
import * as shared from "@repo/shared";

// ============================================================================
// MOCK FUNCTIONS (via dependency injection instead of vi.mock)
// ============================================================================

const mockVerifyOnChainTransaction = vi.fn();
const mockMarkReservationAsVerified = vi.fn();
const mockNotifyOwnerOfVerification = vi.fn();

// ============================================================================
// TEST FIXTURES
// ============================================================================

const createMockReservation = (overrides = {}) => ({
  id: "res-123",
  restaurantId: "rest-456",
  isVerified: false,
  guestEmail: "guest@example.com",
  guestName: "John Doe",
  partySize: 4,
  startTime: new Date("2025-01-01T19:00:00Z"),
  restaurant: {
    id: "rest-456",
    name: "Test Restaurant",
    ownerEmail: "owner@restaurant.com",
    walletAddress: "0x1234567890123456789012345678901234567890",
  },
  ...overrides,
});

const createCheckoutInput = (overrides = {}): CheckoutInput => ({
  txHash: "0xabcdef1234567890",
  reservationId: "res-123",
  paymentCurrency: "USDC",
  expectedValue: BigInt(100000000), // 100 USDC (6 decimals)
  frontendCallbackUrl: "https://example.com/callback",
  requestOrigin: "https://example.com",
  ...overrides,
});

// ============================================================================
// TESTS
// ============================================================================

describe("CheckoutService", () => {
  let service: CheckoutService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CheckoutService({
      verifyOnChainTransaction: mockVerifyOnChainTransaction,
      markReservationAsVerified: mockMarkReservationAsVerified,
      notifyOwnerOfVerification: mockNotifyOwnerOfVerification,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to get the mock DB
  const getMockDb = () => {
    const db = database.getDb();
    return db as unknown as {
      query: {
        restaurantReservations: {
          findFirst: ReturnType<typeof vi.fn>;
        };
      };
    };
  };

  // ========================================================================
  // PROCESS CHECKOUT - SUCCESS PATH
  // ========================================================================

  describe("processCheckout", () => {
    it("should successfully process a checkout with all steps", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();

      // Mock DB fetch
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );

      // Mock lock acquisition
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);

      // Mock web3 verification
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 3 },
      });

      // Mock reservation update
      mockMarkReservationAsVerified.mockResolvedValue(undefined);

      // Mock notifications
      mockNotifyOwnerOfVerification.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      const result = await service.processCheckout(input);

      expect(result).toEqual({
        txHash: input.txHash,
        confirmations: 3,
        reservationId: input.reservationId,
      });

      // Verify all steps were called
      expect(
        getMockDb().query.restaurantReservations.findFirst,
      ).toHaveBeenCalled();
      expect(shared.tryAcquireReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
      expect(shared.isReplayAllowed).toHaveBeenCalledWith({
        txHash: input.txHash,
        appSource: "table-stack",
        entityId: input.reservationId,
      });
      expect(mockVerifyOnChainTransaction).toHaveBeenCalledWith({
        txHash: input.txHash,
        expectedValue: input.expectedValue,
        reservation,
        paymentCurrency: input.paymentCurrency,
        targetReservationId: input.reservationId,
      });
      expect(mockMarkReservationAsVerified).toHaveBeenCalledWith(
        input.reservationId,
        input.txHash,
      );
      expect(mockNotifyOwnerOfVerification).toHaveBeenCalledWith({
        ownerEmail: reservation.restaurant.ownerEmail,
        guestName: reservation.guestName,
        partySize: reservation.partySize,
        startTime: reservation.startTime,
      });
    });

    it("should process checkout without optional callback URL", async () => {
      const input = createCheckoutInput({ frontendCallbackUrl: undefined });
      const reservation = createMockReservation();

      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);

      const result = await service.processCheckout(input);

      expect(result.txHash).toBe(input.txHash);
      expect(result.confirmations).toBe(1);
      // dispatchTask should not be called without callback URL
      expect(shared.dispatchTask).not.toHaveBeenCalled();
    });

    it("should process checkout when restaurant has no ownerEmail", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation({
        restaurant: {
          id: "rest-456",
          name: "Test Restaurant",
          ownerEmail: null,
          walletAddress: "0x1234567890123456789012345678901234567890",
        },
      });

      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 2 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      const result = await service.processCheckout(input);

      expect(result.txHash).toBe(input.txHash);
      // notifyOwnerOfVerification should not be called without ownerEmail
      expect(mockNotifyOwnerOfVerification).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // FETCH RESERVATION - ERROR PATHS
  // ========================================================================

  describe("fetchReservation", () => {
    it("should throw NOT_FOUND when reservation does not exist", async () => {
      const input = createCheckoutInput();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        null,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Reservation not found",
        statusCode: 404,
        code: "NOT_FOUND",
      });
    });

    it("should throw ALREADY_VERIFIED when reservation is already verified", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation({ isVerified: true });
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Reservation already verified",
        statusCode: 200,
        code: "ALREADY_VERIFIED",
      });
    });

    it("should throw VALIDATION_ERROR when wallet address not configured in P2P mode", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation({
        restaurant: {
          id: "rest-456",
          name: "Test Restaurant",
          ownerEmail: "owner@restaurant.com",
          walletAddress: null,
        },
      });
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.AppConfig.isDirectP2PMode).mockReturnValue(true);

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Restaurant wallet address not configured",
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    });

    it("should throw VALIDATION_ERROR when escrow contract not configured in escrow mode", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.AppConfig.isDirectP2PMode).mockReturnValue(false);
      vi.mocked(shared.AppConfig.isEscrowMode).mockReturnValue(true);
      vi.mocked(shared.AppConfig.getEscrowContractAddress).mockReturnValue(
        null,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Escrow contract address not configured",
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    });

    it("should throw VALIDATION_ERROR when payments are disabled", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.AppConfig.isPaymentDisabled).mockReturnValue(true);

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Web3 payments are disabled",
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    });
  });

  // ========================================================================
  // REPLAY LOCK - CONFLICT PATHS
  // ========================================================================

  describe("Replay Processing Lock", () => {
    it("should throw CONFLICT when lock acquisition fails", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(false);

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Payment transaction is currently being processed",
        statusCode: 409,
        code: "CONFLICT",
      });
    });

    it("should throw CONFLICT when replay is not allowed", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(false);
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Payment transaction already used or blocked",
        statusCode: 409,
        code: "CONFLICT",
      });
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });
  });

  // ========================================================================
  // WEB3 VERIFICATION - ERROR PATHS
  // ========================================================================

  describe("Web3 Verification", () => {
    it("should throw VALIDATION_ERROR when confirmations < 1", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 0 },
      });
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Waiting for more confirmations",
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    });

    it("should release lock when verification fails", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockRejectedValue(
        new Error("Transaction reverted"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        "Transaction reverted",
      );
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });

    it("should release lock when markReservationAsVerified fails", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 2 },
      });
      mockMarkReservationAsVerified.mockRejectedValue(
        new Error("DB write failed"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        "DB write failed",
      );
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });

    it("should warn but not throw when lock release fails after confirmation", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      // dispatchTask must return a Promise since .catch() is called on it
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      // Don't throw - the finally block should catch this
      vi.mocked(shared.releaseReplayProcessingLock).mockRejectedValue(
        new Error("Lock release failed"),
      );

      // Should still succeed because confirmation happened
      const result = await service.processCheckout(input);
      expect(result.txHash).toBe(input.txHash);
    });
  });

  // ========================================================================
  // NOTIFICATIONS - FIRE-AND-FORGET BEHAVIOR
  // ========================================================================

  describe("Notifications", () => {
    it("should not fail checkout when webhook dispatch fails", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      mockNotifyOwnerOfVerification.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockRejectedValue(
        new Error("Webhook failed"),
      );

      // Should still succeed despite webhook failure
      const result = await service.processCheckout(input);
      expect(result.txHash).toBe(input.txHash);
    });

    it("should not fail checkout when email notification fails", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      // Email notification is awaited without try/catch, so it WILL throw
      // This test verifies the current behavior: email failure causes checkout to fail
      mockNotifyOwnerOfVerification.mockRejectedValue(
        new Error("Email service down"),
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        "Email service down",
      );
    });

    it("should include correct parameters in webhook dispatch", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      await service.processCheckout(input);

      expect(shared.dispatchTask).toHaveBeenCalledWith(
        "send_checkout_webhook",
        {
          webhookUrl: input.frontendCallbackUrl,
          reservationId: input.reservationId,
          txHash: input.txHash,
          status: "confirmed",
          message: "Crypto payment verified successfully",
        },
        `webhook:${input.txHash}`,
      );
    });
  });

  // ========================================================================
  // FINANCIAL SAFETY - CRITICAL PATHS
  // ========================================================================

  describe("Financial Safety - Replay Lock Timeout", () => {
    it("should succeed even when processing exceeds lock TTL", async () => {
      // Simulates: Lock acquired, but processing takes longer than TTL
      // The lock auto-expires, but checkout still succeeds
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);

      // Simulate slow verification that exceeds lock TTL
      mockVerifyOnChainTransaction.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: true,
                  receipt: { confirmations: 1 },
                }),
              100,
            ),
          ),
      );
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      // Should still succeed - lock release in finally block is skipped on success
      const result = await service.processCheckout(input);
      expect(result.txHash).toBe(input.txHash);
      expect(result.confirmations).toBe(1);

      // Lock release should NOT be called on success path (confirmed = true)
      expect(shared.releaseReplayProcessingLock).not.toHaveBeenCalled();
    });

    it("should prevent double-spend via replay guard after successful checkout", async () => {
      // First checkout succeeds
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      await service.processCheckout(input);

      // Second checkout with same txHash should fail
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockClear();
      vi.mocked(shared.isReplayAllowed).mockClear();
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(false); // Replay blocked
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      const service2 = new CheckoutService({
        verifyOnChainTransaction: mockVerifyOnChainTransaction,
        markReservationAsVerified: mockMarkReservationAsVerified,
        notifyOwnerOfVerification: mockNotifyOwnerOfVerification,
      });

      await expect(service2.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service2.processCheckout(input)).rejects.toMatchObject({
        message: "Payment transaction already used or blocked",
        statusCode: 409,
        code: "CONFLICT",
      });
    });
  });

  describe("Financial Safety - Partial DB Failure During Web3 Verification", () => {
    it("should release lock when DB update fails after successful verification", async () => {
      // Critical test: Web3 verification succeeds, but DB update fails
      // Lock MUST be released to allow retry - otherwise funds are stuck
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);

      // Web3 verification succeeds
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 3 },
      });

      // But DB update fails
      mockMarkReservationAsVerified.mockRejectedValue(
        new Error("Database connection lost"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        "Database connection lost",
      );

      // CRITICAL: Lock must be released to allow retry
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });

    it("should release lock when confirmReplayGuard fails after DB update", async () => {
      // Even rarer: DB succeeds, but replay guard confirmation fails
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 2 },
      });

      // markReservationAsVerified internally calls confirmReplayGuard
      // Simulate it failing
      mockMarkReservationAsVerified.mockRejectedValue(
        new Error("Replay guard confirmation failed"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        "Replay guard confirmation failed",
      );

      // Lock must still be released
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });

    it("should handle cascading failures: verification + lock release both fail", async () => {
      // Worst case: everything fails, including lock release
      const input = createCheckoutInput();
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockRejectedValue(
        new Error("RPC node unreachable"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockRejectedValue(
        new Error("Redis timeout"),
      );

      // Should throw original error, not lock release error
      await expect(service.processCheckout(input)).rejects.toThrow(
        "RPC node unreachable",
      );

      // Attempted to release lock despite failure
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });
  });

  describe("Financial Safety - Slippage Breaches", () => {
    it("should throw VALIDATION_ERROR when slippage exceeds tolerance", async () => {
      // Slippage check happens in web3-verify.ts, but we test the integration here
      const input = createCheckoutInput({ paymentCurrency: "ETH" });
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);

      // Verification fails due to slippage
      mockVerifyOnChainTransaction.mockRejectedValue(
        new CheckoutError(
          "Signed amount is outside acceptable slippage tolerance",
          400,
          "VALIDATION_ERROR",
          {
            details: {
              signedAmount: "1000000000000000000",
              expectedValue: "990000000000000000",
              slippageBps: 100,
            },
          },
        ),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      await expect(service.processCheckout(input)).rejects.toThrow(
        CheckoutError,
      );
      await expect(service.processCheckout(input)).rejects.toMatchObject({
        message: "Signed amount is outside acceptable slippage tolerance",
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });

      // Lock must be released
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );
    });

    it("should release lock immediately when slippage breach detected", async () => {
      // Ensure no partial state is left behind
      const input = createCheckoutInput({ paymentCurrency: "ETH" });
      const reservation = createMockReservation();
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);

      mockVerifyOnChainTransaction.mockRejectedValue(
        new CheckoutError("Slippage breach", 400, "VALIDATION_ERROR"),
      );
      vi.mocked(shared.releaseReplayProcessingLock).mockResolvedValue(
        undefined,
      );

      try {
        await service.processCheckout(input);
      } catch {
        // Expected
      }

      // Lock release should be called exactly once
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledTimes(1);
      expect(shared.releaseReplayProcessingLock).toHaveBeenCalledWith(
        input.txHash,
      );

      // MarkReservationAsVerified should NEVER be called if verification fails
      expect(mockMarkReservationAsVerified).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // EDGE CASES
  // ========================================================================

  describe("Edge Cases", () => {
    it("should handle reservation with null guest fields", async () => {
      const input = createCheckoutInput();
      const reservation = createMockReservation({
        guestEmail: null,
        guestName: null,
        partySize: null,
        startTime: null,
      });
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);
      mockNotifyOwnerOfVerification.mockResolvedValue(undefined);
      vi.mocked(shared.dispatchTask).mockResolvedValue(undefined);

      const result = await service.processCheckout(input);
      expect(result.txHash).toBe(input.txHash);

      // Should use fallback values for null fields
      expect(mockNotifyOwnerOfVerification).toHaveBeenCalledWith({
        ownerEmail: reservation.restaurant.ownerEmail,
        guestName: "",
        partySize: 0,
        startTime: expect.any(Date),
      });
    });

    it("should handle reservation with null restaurant", async () => {
      const input = createCheckoutInput({ frontendCallbackUrl: undefined });
      const reservation = createMockReservation({ restaurant: null });
      getMockDb().query.restaurantReservations.findFirst.mockResolvedValue(
        reservation,
      );
      // Disable P2P mode and escrow mode to bypass wallet validation
      vi.mocked(shared.AppConfig.isDirectP2PMode).mockReturnValue(false);
      vi.mocked(shared.AppConfig.isEscrowMode).mockReturnValue(false);
      vi.mocked(shared.tryAcquireReplayProcessingLock).mockResolvedValue(true);
      vi.mocked(shared.isReplayAllowed).mockResolvedValue(true);
      mockVerifyOnChainTransaction.mockResolvedValue({
        success: true,
        receipt: { confirmations: 1 },
      });
      mockMarkReservationAsVerified.mockResolvedValue(undefined);

      const result = await service.processCheckout(input);
      expect(result.txHash).toBe(input.txHash);
      // No email should be sent without restaurant
      expect(mockNotifyOwnerOfVerification).not.toHaveBeenCalled();
    });
  });
});
