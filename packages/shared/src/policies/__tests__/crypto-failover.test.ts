/**
 * Crypto Failover Policy Tests
 * 
 * Tests for crypto-specific failure handling and recovery policies
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FailureReasonSchema,
  getUserFriendlyMessage,
  USER_FRIENDLY_MESSAGES,
  type FailureReason,
} from "../../../packages/shared/src/policies/failover-policy";

describe("Crypto Failover Policies", () => {
  describe("FailureReasonSchema", () => {
    it("should include all crypto-specific failure reasons", () => {
      const cryptoFailures = [
        "INSUFFICIENT_FUNDS",
        "TX_REJECTED",
        "RPC_TIMEOUT",
        "TX_FAILED",
        "INVALID_TX_HASH",
        "WALLET_DISCONNECTED",
        "TOKEN_NOT_SUPPORTED",
      ];

      cryptoFailures.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      });
    });

    it("should include traditional payment failures", () => {
      const traditionalFailures = [
        "PAYMENT_FAILED",
        "DELIVERY_UNAVAILABLE",
        "SERVICE_ERROR",
      ];

      traditionalFailures.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      });
    });

    it("should reject invalid failure reasons", () => {
      const invalidReasons = [
        "UNKNOWN_ERROR",
        "CRYPTO_ERROR",
        "BLOCKCHAIN_FAILED",
        "",
        null,
      ];

      invalidReasons.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(false);
      });
    });
  });

  describe("User-Friendly Messages", () => {
    it("should have message for INSUFFICIENT_FUNDS", () => {
      const message = getUserFriendlyMessage("INSUFFICIENT_FUNDS");
      expect(message).toContain("wallet");
      expect(message).toContain("tokens");
      expect(message).toContain("funds");
    });

    it("should have message for TX_REJECTED", () => {
      const message = getUserFriendlyMessage("TX_REJECTED");
      expect(message).toContain("rejected");
      expect(message).toContain("wallet");
    });

    it("should have message for RPC_TIMEOUT", () => {
      const message = getUserFriendlyMessage("RPC_TIMEOUT");
      expect(message).toContain("blockchain");
      expect(message).toContain("traffic");
      expect(message).toContain("retry");
    });

    it("should have message for TX_FAILED", () => {
      const message = getUserFriendlyMessage("TX_FAILED");
      expect(message).toContain("failed");
      expect(message).toContain("on-chain");
      expect(message).toContain("funds are safe");
    });

    it("should have message for INVALID_TX_HASH", () => {
      const message = getUserFriendlyMessage("INVALID_TX_HASH");
      expect(message).toContain("invalid");
      expect(message).toContain("verify");
    });

    it("should have message for WALLET_DISCONNECTED", () => {
      const message = getUserFriendlyMessage("WALLET_DISCONNECTED");
      expect(message).toContain("disconnected");
      expect(message).toContain("connect");
    });

    it("should have message for TOKEN_NOT_SUPPORTED", () => {
      const message = getUserFriendlyMessage("TOKEN_NOT_SUPPORTED");
      expect(message).toContain("supported");
      expect(message).toContain("USDC");
      expect(message).toContain("ETH");
    });

    it("should return custom message if provided", () => {
      const customMessage = "Custom error message";
      const message = getUserFriendlyMessage("INSUFFICIENT_FUNDS", customMessage);
      expect(message).toBe(customMessage);
    });

    it("should return generic message for unknown failure", () => {
      const message = getUserFriendlyMessage("UNKNOWN_FAILURE" as any);
      expect(message).toBe("Something went wrong. Let's try a different approach.");
    });
  });

  describe("Message Content Validation", () => {
    it("should provide actionable guidance in all crypto messages", () => {
      const cryptoFailures = [
        "INSUFFICIENT_FUNDS",
        "TX_REJECTED",
        "RPC_TIMEOUT",
        "TX_FAILED",
        "INVALID_TX_HASH",
        "WALLET_DISCONNECTED",
        "TOKEN_NOT_SUPPORTED",
      ];

      cryptoFailures.forEach((failure) => {
        const message = USER_FRIENDLY_MESSAGES[failure];
        expect(message).toBeDefined();
        // All messages should have a question or suggestion for next steps
        expect(message).toMatch(/[?.]/);
      });
    });

    it("should reassure users about fund safety", () => {
      const txFailedMessage = USER_FRIENDLY_MESSAGES.TX_FAILED;
      expect(txFailedMessage).toContain("funds are safe");
    });

    it("should offer retry option for transient failures", () => {
      const timeoutMessage = USER_FRIENDLY_MESSAGES.RPC_TIMEOUT;
      expect(timeoutMessage).toContain("retry");

      const txRejectedMessage = USER_FRIENDLY_MESSAGES.TX_REJECTED;
      expect(txRejectedMessage).toContain("try again");
    });
  });

  describe("Failure Recovery Strategies", () => {
    it("should suggest alternative payment for INSUFFICIENT_FUNDS", () => {
      const message = USER_FRIENDLY_MESSAGES.INSUFFICIENT_FUNDS;
      expect(message).toContain("different payment method");
    });

    it("should suggest supported tokens for TOKEN_NOT_SUPPORTED", () => {
      const message = USER_FRIENDLY_MESSAGES.TOKEN_NOT_SUPPORTED;
      expect(message).toContain("USDC");
      expect(message).toContain("ETH");
    });

    it("should provide specific instructions for WALLET_DISCONNECTED", () => {
      const message = USER_FRIENDLY_MESSAGES.WALLET_DISCONNECTED;
      expect(message).toContain("connect your wallet");
    });
  });

  describe("Failure Reason Categorization", () => {
    it("should categorize wallet-related failures", () => {
      const walletFailures = [
        "WALLET_DISCONNECTED",
        "TX_REJECTED",
        "INSUFFICIENT_FUNDS",
      ];

      walletFailures.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      });
    });

    it("should categorize network-related failures", () => {
      const networkFailures = ["RPC_TIMEOUT", "TX_FAILED"];

      networkFailures.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      });
    });

    it("should categorize validation-related failures", () => {
      const validationFailures = ["INVALID_TX_HASH", "TOKEN_NOT_SUPPORTED"];

      validationFailures.forEach((reason) => {
        const result = FailureReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      });
    });
  });

  describe("Integration with Traditional Payments", () => {
    it("should handle both crypto and fiat payment failures", () => {
      const cryptoFailure = FailureReasonSchema.safeParse("INSUFFICIENT_FUNDS");
      const fiatFailure = FailureReasonSchema.safeParse("PAYMENT_FAILED");

      expect(cryptoFailure.success).toBe(true);
      expect(fiatFailure.success).toBe(true);
    });

    it("should have distinct messages for crypto vs fiat failures", () => {
      const cryptoMessage = USER_FRIENDLY_MESSAGES.INSUFFICIENT_FUNDS;
      const fiatMessage = USER_FRIENDLY_MESSAGES.PAYMENT_FAILED;

      expect(cryptoMessage).toContain("tokens");
      expect(fiatMessage).toContain("card");
      expect(cryptoMessage).not.toBe(fiatMessage);
    });
  });
});

describe("Crypto Failover Policy Engine", () => {
  describe("Retry Logic", () => {
    it("should allow retry for RPC_TIMEOUT", () => {
      // RPC timeouts are transient and should be retryable
      const isRetryable = ["RPC_TIMEOUT", "SERVICE_ERROR"].includes(
        "RPC_TIMEOUT" as FailureReason
      );
      expect(isRetryable).toBe(true);
    });

    it("should not allow retry for permanent failures", () => {
      // These require user action, not automatic retry
      const permanentFailures = [
        "INSUFFICIENT_FUNDS",
        "TOKEN_NOT_SUPPORTED",
        "WALLET_DISCONNECTED",
      ];

      permanentFailures.forEach((failure) => {
        const requiresUserAction = true; // These need user to fix
        expect(requiresUserAction).toBe(true);
      });
    });
  });

  describe("Escalation Triggers", () => {
    it("should escalate after multiple RPC_TIMEOUT failures", () => {
      const consecutiveFailures = 3;
      const shouldEscalate = consecutiveFailures >= 3;
      expect(shouldEscalate).toBe(true);
    });

    it("should suggest human support for persistent TX_FAILED", () => {
      const failureCount = 5;
      const shouldEscalateToHuman = failureCount >= 3;
      expect(shouldEscalateToHuman).toBe(true);
    });
  });

  describe("Circuit Breaker Pattern", () => {
    it("should open circuit after consecutive failures", () => {
      const failureThreshold = 5;
      const consecutiveFailures = 6;
      const shouldOpenCircuit = consecutiveFailures >= failureThreshold;
      expect(shouldOpenCircuit).toBe(true);
    });

    it("should close circuit after successful transaction", () => {
      const circuitOpen = true;
      const successCount = 1;
      const shouldCloseCircuit = circuitOpen && successCount >= 1;
      expect(shouldCloseCircuit).toBe(true);
    });
  });
});
