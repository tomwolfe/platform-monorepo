#!/usr/bin/env bash
# Seed Anvil with Mock Contracts for Deterministic CI Testing
#
# This script deploys mock contracts to the Anvil instance running in Docker.
# It uses a fixed mnemonic, so the deployed contract addresses are deterministic.
#
# Usage:
#   ./scripts/seed-anvil.sh              # Deploy to localhost:8545
#   ./scripts/seed-anvil.sh --ci         # Deploy to anvil:8545 (CI environment)
#   ./scripts/seed-anvil.sh --dry-run    # Print commands without executing
#
# Dependencies:
#   - foundry (anvil, forge, cast)
#   - Docker (for running Anvil container)
#
# Exit codes:
#   0 - Success
#   1 - Failed to connect to Anvil
#   2 - Failed to deploy contracts

set -euo pipefail

# Configuration
ANVIL_URL="${ANVIL_RPC_URL:-http://localhost:8545}"
CHAIN_ID=31337
DEPLOYER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # First account from test mnemonic
VERBOSE=false
DRY_RUN=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --ci)
      ANVIL_URL="http://anvil:8545"
      ;;
    --verbose)
      VERBOSE=true
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --url=*)
      ANVIL_URL="${arg#*=}"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--ci] [--verbose] [--dry-run] [--url=<anvil_url>]"
      exit 1
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
  echo -e "${GREEN}[seed-anvil]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[seed-anvil] WARN${NC} $1"
}

error() {
  echo -e "${RED}[seed-anvil] ERROR${NC} $1" >&2
}

# Check if Anvil is reachable
wait_for_anvil() {
  local max_attempts=30
  local attempt=0
  local wait_seconds=2

  log "Waiting for Anvil at $ANVIL_URL..."

  while [ $attempt -lt $max_attempts ]; do
    if cast chain-id --rpc-url "$ANVIL_URL" &>/dev/null; then
      local chain_id
      chain_id=$(cast chain-id --rpc-url "$ANVIL_URL")
      if [ "$chain_id" = "$CHAIN_ID" ]; then
        log "Anvil is ready (chain ID: $chain_id)"
        return 0
      else
        error "Unexpected chain ID: $chain_id (expected: $CHAIN_ID)"
        return 1
      fi
    fi
    attempt=$((attempt + 1))
    sleep $wait_seconds
  done

  error "Anvil failed to start after $((max_attempts * wait_seconds)) seconds"
  return 1
}

# Deploy mock USDC contract
deploy_mock_usdc() {
  log "Deploying mock USDC contract..."

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] forge script scripts/seed-anvil/DeployMockUSDC.s.sol:DeployMockUSDCScript --rpc-url $ANVIL_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify false"
    return 0
  fi

  # Deploy using Foundry script
  local output
  output=$(forge script \
    scripts/seed-anvil/DeployMockUSDC.s.sol:DeployMockUSDCScript \
    --rpc-url "$ANVIL_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --broadcast \
    --verify false \
    2>&1) || {
    error "Failed to deploy mock USDC: $output"
    return 2
  }

  if [ "$VERBOSE" = true ]; then
    echo "$output"
  fi

  # Extract deployed address from output
  local usdc_address
  usdc_address=$(echo "$output" | grep -o '0x[a-fA-F0-9]\{40\}' | head -1)

  if [ -n "$usdc_address" ]; then
    log "Mock USDC deployed at: $usdc_address"
    echo "USDC_ADDRESS=$usdc_address"
  else
    warn "Could not extract USDC address from deployment output"
  fi
}

# Deploy mock Escrow contract
deploy_mock_escrow() {
  log "Deploying mock Escrow contract..."

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] forge script scripts/seed-anvil/DeployMockEscrow.s.sol:DeployMockEscrowScript --rpc-url $ANVIL_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify false"
    return 0
  fi

  local output
  output=$(forge script \
    scripts/seed-anvil/DeployMockEscrow.s.sol:DeployMockEscrowScript \
    --rpc-url "$ANVIL_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --broadcast \
    --verify false \
    2>&1) || {
    error "Failed to deploy mock Escrow: $output"
    return 2
  }

  if [ "$VERBOSE" = true ]; then
    echo "$output"
  fi

  local escrow_address
  escrow_address=$(echo "$output" | grep -o '0x[a-fA-F0-9]\{40\}' | head -1)

  if [ -n "$escrow_address" ]; then
    log "Mock Escrow deployed at: $escrow_address"
    echo "ESCROW_ADDRESS=$escrow_address"
  else
    warn "Could not extract Escrow address from deployment output"
  fi
}

# Main execution
main() {
  log "Starting Anvil seeding process..."
  log "Anvil URL: $ANVIL_URL"
  log "Chain ID: $CHAIN_ID"
  log "Deployer: $DEPLOYER_PRIVATE_KEY"

  # Wait for Anvil to be ready
  wait_for_anvil

  # Check account balance
  local balance
  balance=$(cast balance "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" --rpc-url "$ANVIL_URL" 2>/dev/null)
  log "Deployer account balance: $balance wei"

  # Deploy contracts
  deploy_mock_usdc
  deploy_mock_escrow

  log "Anvil seeding complete!"
  log ""
  log "To use these contracts in your tests, set the following environment variables:"
  log "  export NEXT_PUBLIC_USDC_CONTRACT_ADDRESS=<deployed_address>"
  log "  export NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS=<deployed_address>"
  log ""
  log "Test accounts (first 3):"
  log "  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (deployer, 10000 ETH)"
  log "  0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
  log "  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
}

# Run main
main "$@"
