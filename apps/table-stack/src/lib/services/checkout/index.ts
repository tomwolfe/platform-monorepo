/**
 * Checkout Service Barrel
 *
 * Re-exports all checkout modules for easy importing.
 *
 * @see Task 5: Refactor Monolithic Service Files
 * @see Task 4: Consolidate Checkout Logic (checkout-logic.ts)
 */

export {
  CheckoutError,
  EIP712_DOMAIN,
  EIP712_TYPES,
  getEIP712Domain,
  DEADLINE_TOLERANCE_SECONDS,
  validateDeadline,
  validateChainId,
  validatePaymentMode,
  verifySignature,
  calculateExpectedCryptoAmount,
} from "./validation";

export {
  verifyOnChainTransaction,
  verifyTransactionData,
  validateTransactionHash,
} from "./web3-verify";

export { markReservationAsVerified } from "./reservation-update";

export { notifyOwnerOfVerification } from "./notifications";

export { CheckoutService, checkoutService } from "./checkout.service";
export type { CheckoutInput, CheckoutResult } from "./checkout.service";

// Unified import path (consolidated)
export * from "./checkout-logic";
