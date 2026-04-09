#!/usr/bin/env bash
# ============================================================================
# Fund Test Wallets from Anvil's Pre-funded Accounts
#
# This script sends ETH and (optionally) test USDC from Anvil's default
# rich accounts to the test driver/user wallets defined in .env.local.
#
# Usage:
#   bash scripts/fund-test-wallets.sh [options]
#
# Options:
#   --rpc-url <URL>        Anvil RPC URL (default: http://localhost:8545)
#   --chain-id <ID>        Chain ID (default: 31337)
#   --eth-amount <AMT>     ETH to send per wallet (default: 10)
#   --dry-run              Show what would be done without executing
#   --help                 Show this help message
#
# Prerequisites:
#   - Anvil running: anvil --chain-id 31337 --host 0.0.0.0 --port 8545
#   - Foundry installed: curl -L https://foundry.paradigm.xyz | bash && foundryup
#   - cast CLI available (bundled with Foundry)
# ============================================================================

set -euo pipefail

# Default values
RPC_URL="http://localhost:8545"
CHAIN_ID=31337
ETH_AMOUNT=10
DRY_RUN=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

print_help() {
  head -20 "$0" | tail -17 | sed 's/^# \?//'
  exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --rpc-url)
      RPC_URL="$2"
      shift 2
      ;;
    --chain-id)
      CHAIN_ID="$2"
      shift 2
      ;;
    --eth-amount)
      ETH_AMOUNT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      print_help
      ;;
    *)
      log_error "Unknown option: $1"
      print_help
      ;;
  esac
done

# ============================================================================
# Pre-flight Checks
# ============================================================================

# Check if cast is available
if ! command -v cast &> /dev/null; then
  log_error "cast is not available. Install Foundry:"
  echo "  curl -L https://foundry.paradigm.xyz | bash"
  echo "  foundryup"
  exit 1
fi

# Check if Anvil is running
if ! curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  | grep -q "result"; then
  log_error "Anvil is not running at $RPC_URL"
  echo "  Start Anvil: anvil --chain-id $CHAIN_ID --host 0.0.0.0 --port 8545"
  exit 1
fi

log_success "Connected to Anvil at $RPC_URL (chain ID: $CHAIN_ID)"

# ============================================================================
# Load Environment Variables
# ============================================================================

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE=".env"
fi

if [ ! -f "$ENV_FILE" ]; then
  log_error "No .env.local or .env file found"
  exit 1
fi

# Source the env file to get wallet addresses
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Test wallet addresses (from .env or defaults)
DRIVER_WALLET="${TEST_DRIVER_WALLET:-}"
USER_WALLET="${TEST_USER_WALLET:-}"
RESTAURANT_WALLET="${TEST_RESTAURANT_WALLET:-}"

# Collect wallets to fund
WALLETS=()
WALLET_NAMES=()

if [ -n "$DRIVER_WALLET" ]; then
  WALLETS+=("$DRIVER_WALLET")
  WALLET_NAMES+=("Driver Wallet")
fi

if [ -n "$USER_WALLET" ]; then
  WALLETS+=("$USER_WALLET")
  WALLET_NAMES+=("User Wallet")
fi

if [ -n "$RESTAURANT_WALLET" ]; then
  WALLETS+=("$RESTAURANT_WALLET")
  WALLET_NAMES+=("Restaurant Wallet")
fi

if [ ${#WALLETS[@]} -eq 0 ]; then
  log_error "No test wallet addresses found in $ENV_FILE"
  echo "  Set one or more of: TEST_DRIVER_WALLET, TEST_USER_WALLET, TEST_RESTAURANT_WALLET"
  exit 1
fi

# ============================================================================
# Get Anvil's First Account (pre-funded with 10,000 ETH)
# ============================================================================

# Anvil's first default account (index 0)
ANVIL_ACCOUNT=$(cast accounts --mnemonic "test test test test test test test test test test test junk" | head -1)
ANVIL_PRIVATE_KEY=$(cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 0)

if [ -z "$ANVIL_ACCOUNT" ] || [ -z "$ANVIL_PRIVATE_KEY" ]; then
  # Fallback: Use known Anvil default account 0
  ANVIL_ACCOUNT="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  ANVIL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
fi

log_info "Funding from Anvil account: $ANVIL_ACCOUNT"

# ============================================================================
# Fund Wallets
# ============================================================================

log_info "Funding ${#WALLETS[@]} wallet(s) with ${ETH_AMOUNT} ETH each..."

if [ "$DRY_RUN" = true ]; then
  log_warn "DRY RUN MODE - no transactions will be sent"
  for i in "${!WALLETS[@]}"; do
    echo "  ${WALLET_NAMES[$i]}: ${WALLETS[$i]} -> ${ETH_AMOUNT} ETH"
  done
  exit 0
fi

for i in "${!WALLETS[@]}"; do
  wallet="${WALLETS[$i]}"
  name="${WALLET_NAMES[$i]}"

  log_info "Sending ${ETH_AMOUNT} ETH to $name ($wallet)..."

  # Send ETH
  tx_hash=$(cast send "$wallet" \
    --value "${ETH_AMOUNT}ether" \
    --rpc-url "$RPC_URL" \
    --private-key "$ANVIL_PRIVATE_KEY" \
    --json \
    | grep -o '"transactionHash":"[^"]*"' \
    | cut -d'"' -f4)

  if [ -n "$tx_hash" ]; then
    log_success "$name funded: $tx_hash"

    # Check balance
    balance=$(cast balance "$wallet" --rpc-url "$RPC_URL" | head -1)
    log_info "  New balance: $balance ETH"
  else
    log_error "Failed to fund $name"
  fi
done

# ============================================================================
# Summary
# ============================================================================

echo ""
log_success "Wallet funding complete!"
echo ""
echo "Funded wallets:"
for i in "${!WALLETS[@]}"; do
  balance=$(cast balance "${WALLETS[$i]}" --rpc-url "$RPC_URL" | head -1)
  echo "  ${WALLET_NAMES[$i]} (${WALLETS[$i]}): ${balance} ETH"
done
