# Crypto Payment Migration Guide

## Overview

This migration converts the entire platform from Stripe/fiat payments to 100% crypto payments using USDC/ETH on Base (and other EVM-compatible chains).

## What Changed

### Database Schema

**New Columns:**
- `restaurants.wallet_address` - Crypto wallet for receiving direct payments
- `restaurant_reservations.payment_tx_hash` - On-chain transaction hash for verification

**Deprecated Columns:**
- `restaurants.stripe_account_id` - No longer used
- `restaurant_reservations.stripe_payment_intent_id` - No longer used

### Architecture Changes

#### Before (Stripe Model)
```
Customer → Stripe → Platform Account → Stripe Connect → Restaurant
                          ↓
                    Platform Fee
```

#### After (Direct Crypto Model)
```
Customer → Restaurant Wallet (USDC/ETH)
       ↓
    Treasury (Driver Tip)
```

**Benefits:**
- ✅ No Stripe fees (2.9% + $0.30 per transaction)
- ✅ Instant settlement (no 2-7 day waiting period)
- ✅ Global payments (no geographic restrictions)
- ✅ Censorship resistant (no centralized payment processor)
- ✅ Transparent (all transactions verifiable on-chain)

## Migration Steps

### 1. Run Database Migration

```bash
cd packages/database
pnpm drizzle-kit migrate
```

This will:
- Add `wallet_address` column to `restaurants` table
- Add `payment_tx_hash` column to `restaurant_reservations` table
- Create indexes for performance

### 2. Configure Environment Variables

Update `.env` files for both `table-stack` and `open-delivery`:

```bash
# Required: Treasury wallet address (fallback if restaurant has no wallet)
NEXT_PUBLIC_TREASURY_WALLET_ADDRESS=0x...

# Required: Base RPC URL for transaction verification
BASE_RPC_URL=https://mainnet.base.org

# Optional: Minimum confirmations required (default: 3 for orders, 1 for reservations)
NEXT_PUBLIC_MIN_CONFIRMATIONS=3

# Optional: Alternative RPC for redundancy
# NEXT_PUBLIC_ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### 3. Restaurant Wallet Setup

Restaurant owners need to connect their crypto wallet in the Table-Stack dashboard:

1. Navigate to `/dashboard/[restaurantId]`
2. Find the "Crypto Payouts & Deposits" section
3. Enter your EVM-compatible wallet address (0x...)
4. Click "Link"

**Supported Wallets:**
- MetaMask
- Coinbase Wallet
- Rainbow
- Any EVM wallet supporting Base network

### 4. Test the Flow

#### Test Reservation Payment (Table-Stack)

```bash
# Start table-stack
cd apps/table-stack
pnpm dev

# Navigate to a restaurant booking page
# http://localhost:3000/book/[restaurant-slug]

# Create a reservation and pay with crypto
```

#### Test Delivery Order (Open-Delivery)

```bash
# Start open-delivery
cd apps/open-delivery
pnpm dev

# Navigate to customer page
# http://localhost:3000/customer

# Place an order and pay with crypto
```

### 5. Verify Transactions

Transactions can be verified on BaseScan:
- BaseScan: https://basescan.org/

Example verification:
```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ 
  transport: http('https://mainnet.base.org'),
  chain: base 
});

const receipt = await client.getTransactionReceipt({ 
  hash: '0x...' // Your tx hash
});

console.log('Status:', receipt.status); // 'success' or 'reverted'
```

## Payment Flow Details

### Reservation Deposits (Table-Stack)

1. Guest selects reservation time
2. System calculates deposit amount (e.g., $10 per person)
3. Guest connects wallet and pays deposit in ETH/USDC
4. Transaction sent **directly to restaurant wallet**
5. Backend verifies on-chain transaction
6. Reservation confirmed

### Delivery Orders (Open-Delivery)

1. Customer adds items to cart
2. Customer sets tip amount for driver
3. Customer connects wallet
4. If restaurant has wallet: Payment sent **directly to restaurant**
5. If no restaurant wallet: Payment sent to **treasury wallet**
6. Backend verifies transaction on-chain
7. Order broadcast to drivers
8. Driver tip distributed from treasury

## Smart Contract Integration (Future)

For production USDC payments (not just ETH), integrate the USDC contract:

```typescript
import { parseAbi } from 'viem';

const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
]);

// Transfer USDC
const { writeContract } = useWriteContract();

writeContract({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  abi: USDC_ABI,
  functionName: 'transfer',
  args: [restaurantWallet, amount],
});
```

## Removing Stripe Completely

After confirming all restaurants have linked wallets and no pending Stripe transactions:

1. Remove Stripe dependencies:
```bash
pnpm remove stripe @stripe/stripe-js
```

2. Remove Stripe code from codebase:
```bash
# Search for Stripe imports and remove
grep -r "stripe" apps/ packages/ --include="*.ts" --include="*.tsx"
```

3. Drop Stripe columns from database (optional):
```sql
ALTER TABLE restaurants DROP COLUMN IF EXISTS stripe_account_id;
ALTER TABLE restaurant_reservations DROP COLUMN IF EXISTS stripe_payment_intent_id;
```

## Troubleshooting

### Transaction Not Verifying

**Issue:** Transaction shows as pending or fails verification

**Solutions:**
1. Check transaction on BaseScan: https://basescan.org/
2. Verify sufficient confirmations (wait 1-3 minutes)
3. Ensure correct RPC URL in environment variables
4. Check gas fees were sufficient

### Wallet Connection Issues

**Issue:** Wallet won't connect or shows wrong network

**Solutions:**
1. Ensure wallet supports Base network
2. Add Base network to wallet manually:
   - Chain ID: 8453
   - RPC: https://mainnet.base.org
   - Explorer: https://basescan.org/
3. Clear wallet cache and reconnect

### Restaurant Not Receiving Payments

**Issue:** Payments going to treasury instead of restaurant

**Solutions:**
1. Verify restaurant wallet address is correctly set in dashboard
2. Check wallet address format (must be 0x... with 40 hex chars)
3. Ensure wallet address is saved in database:
```sql
SELECT wallet_address FROM restaurants WHERE id = '...';
```

## Security Considerations

### Zero-Trust Verification

All payments are verified on-chain before confirming orders:
- ✅ Transaction hash format validated
- ✅ Transaction status verified (must be 'success')
- ✅ Recipient address verified (matches restaurant or treasury)
- ✅ Amount verified (matches expected total)
- ✅ Confirmations checked (minimum 1-3 blocks)

### Private Key Management

**NEVER** store private keys in the database or environment variables.

- Restaurant wallets are **receive-only** addresses
- Payouts to drivers use separate treasury management
- Consider using a multisig wallet for treasury (e.g., Safe)

## Support

For issues or questions:
- Check transaction on BaseScan
- Review backend logs for verification errors
- Test with small amounts first
- Use testnet before mainnet (Base Sepolia)

## Migration Checklist

- [ ] Run database migration
- [ ] Configure environment variables
- [ ] Test wallet connection in table-stack
- [ ] Test wallet connection in open-delivery
- [ ] Link restaurant wallets for all active restaurants
- [ ] Test reservation payment flow
- [ ] Test delivery order payment flow
- [ ] Verify transactions on BaseScan
- [ ] Remove Stripe dependencies (after testing)
- [ ] Update documentation for users

---

**Migration completed:** ✅ Platform is now 100% crypto-native!
