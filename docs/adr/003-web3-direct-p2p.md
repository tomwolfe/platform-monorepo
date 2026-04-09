# ADR-003: Web3 Direct P2P Payment Model

**Status:** Accepted
**Date:** 2025-02-01
**Context:** Crypto Payment Architecture for Restaurant Reservations

## Problem

Restaurant reservations require a deposit payment. In traditional Web3 escrow patterns, funds are locked in a smart contract until the reservation is fulfilled, then released. This introduces gas costs for both lock and release, contract deployment complexity, and funds are unavailable to the restaurant during the lock period.

## Decision

Implement a **configurable payment mode** with three tiers, defaulting to **Direct P2P**:

### Mode 1: Direct P2P (Default)

- Customer sends crypto directly to the restaurant's wallet address
- Zero intermediary contracts; funds are immediately available to the restaurant
- EIP-712 typed data signature proves customer intent and reservation binding
- On-chain verification confirms: recipient address, amount (with slippage tolerance), and confirmations
- Reservation ID is encoded in transaction `data` field for audit trail

### Mode 2: Escrow (Optional)

- Funds locked in a shared escrow smart contract
- Released upon reservation fulfillment or cancellation
- Higher gas costs but provides buyer protection

### Mode 3: Disabled

- Web3 payments disabled; traditional payment methods only

### Key Design Decisions

1. **Never trust `expectedAmount` from client** — always calculated server-side from DB deposit amount + live oracle price
2. **Slippage tolerance** — configurable via `AppConfig.getSlippageBps()` (default: 300 bps = 3%)
3. **Replay guard** — `processed_crypto_transactions` table prevents double-use of transaction hashes
4. **Two-phase commit** — processing lock (120s TTL) → DB update → confirmed state (24h TTL)

### Alternatives Considered

1. **Escrow-only** — Safer for customers but higher gas costs and restaurant friction
2. **Stablecoin-only (USDC)** — Simpler (no slippage) but excludes ETH-native users
3. **Off-chain payment** — Loses Web3 transparency and composability benefits

## Consequences

- **Positive:** Near-zero gas fees for restaurants (no contract interaction)
- **Positive:** Immediate fund availability
- **Negative:** No built-in buyer protection (mitigated by reputation system and dispute webhook)
- **Negative:** Price volatility risk during checkout window (mitigated by EIP-712 deadline + slippage check)

## Related

- ADR-002: Transactional Outbox Pattern
- `packages/shared/src/utils/web3-verification.ts`
- `packages/shared/src/middleware/web3-replay-guard.ts`
- `apps/table-stack/src/app/api/v1/checkout/route.ts`
- `packages/shared/src/utils/crypto-price.ts`
