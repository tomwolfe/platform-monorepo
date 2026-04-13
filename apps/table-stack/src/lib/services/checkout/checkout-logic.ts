/**
 * Checkout Logic - Unified Module
 *
 * Consolidated checkout logic that re-exports all modules for easy importing.
 * This file serves as a single import point while maintaining testability
 * of individual modules (validation, web3-verify, reservation-update).
 *
 * @see Task 4: Consolidate Checkout Logic
 *
 * Usage:
 * ```typescript
 * import {
 *   checkoutService,
 *   validateDeadline,
 *   validateChainId,
 *   verifySignature,
 *   verifyOnChainTransaction,
 *   markReservationAsVerified,
 *   CheckoutError
 * } from './checkout-logic';
 * ```
 */

// Re-export all validation logic
export {
  CheckoutError,
  EIP712_DOMAIN_STATIC as EIP712_DOMAIN,
  EIP712_TYPES,
  getEIP712Domain,
  DEADLINE_TOLERANCE_SECONDS,
  validateDeadline,
  validateChainId,
  validatePaymentMode,
  verifySignature,
  calculateExpectedCryptoAmount,
} from "./validation";

// Re-export all Web3 verification logic
export {
  verifyOnChainTransaction,
  verifyTransactionData,
  validateTransactionHash,
  safeToHex,
  safeToAddress,
} from "./web3-verify";

// Re-export reservation update logic
export { markReservationAsVerified } from "./reservation-update";

// Re-export notification logic
export { notifyOwnerOfVerification } from "./notifications";

// Re-export orchestrator service
export { CheckoutService, checkoutService } from "./checkout.service";
export type { CheckoutInput, CheckoutResult } from "./checkout.service";
