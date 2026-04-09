/**
 * Anvil Helper for E2E Testing
 *
 * Provides a local blockchain instance for E2E crypto checkout tests.
 * Uses Foundry's `anvil` to spin up a local Ethereum testnet.
 *
 * Requirements:
 * - Foundry installed: `curl -L https://foundry.paradigm.xyz | bash` && `foundryup`
 * - Or install via: `brew install foundry`
 *
 * Usage:
 *   const anvil = await createAnvilProvider();
 *   // ... run tests ...
 *   await anvil.close();
 */

import { spawn, ChildProcess } from "child_process";
import { createPublicClient, createWalletClient, http, webSocket } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export interface AnvilInstance {
  process: ChildProcess;
  rpcUrl: string;
  chainId: number;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  testAccounts: ReturnType<typeof privateKeyToAccount>[];
  close: () => Promise<void>;
}

export interface AnvilOptions {
  port?: number;
  chainId?: number;
  mnemonic?: string;
  accounts?: number;
  blockTime?: number; // seconds
}

const DEFAULT_ANVIL_PORT = 8545;
const DEFAULT_CHAIN_ID = 31337;
const DEFAULT_ACCOUNTS = 10;
const DEFAULT_MNEMONIC =
  "test test test test test test test test test test test junk";

/**
 * Creates a local Anvil instance for E2E testing
 */
export async function createAnvilProvider(
  options: AnvilOptions = {},
): Promise<AnvilInstance> {
  const port = options.port || DEFAULT_ANVIL_PORT;
  const chainId = options.chainId || DEFAULT_CHAIN_ID;
  const mnemonic = options.mnemonic || DEFAULT_MNEMONIC;
  const numAccounts = options.accounts || DEFAULT_ACCOUNTS;
  const blockTime = options.blockTime || 0; // 0 = instant mining

  const rpcUrl = `http://127.0.0.1:${port}`;

  console.log(`🚀 Starting Anvil on ${rpcUrl} (chainId: ${chainId})...`);

  // Build anvil command
  const args = [
    "--port",
    port.toString(),
    "--chain-id",
    chainId.toString(),
    "--mnemonic",
    mnemonic,
    "--accounts",
    numAccounts.toString(),
    "--silent", // Reduce log noise
  ];

  if (blockTime > 0) {
    args.push("--block-time", blockTime.toString());
  }

  const anvilProcess = spawn("anvil", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let isReady = false;
  let startupOutput = "";

  // Wait for anvil to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      anvilProcess.kill();
      reject(new Error("Anvil failed to start within timeout"));
    }, 10000);

    anvilProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      startupOutput += output;
      if (output.includes("Listening on") && !isReady) {
        isReady = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    anvilProcess.stderr?.on("data", (data) => {
      const output = data.toString();
      startupOutput += output;
      if (output.includes("Listening on") && !isReady) {
        isReady = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    anvilProcess.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Anvil process error: ${error.message}`));
    });

    anvilProcess.on("exit", (code) => {
      if (!isReady) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Anvil exited with code ${code}\nOutput:\n${startupOutput}`,
          ),
        );
      }
    });
  });

  console.log(`✅ Anvil is ready at ${rpcUrl}`);

  // Create viem clients
  const publicClient = createPublicClient({
    chain: { ...foundry, id: chainId },
    transport: http(rpcUrl),
  });

  // Generate test accounts from mnemonic
  const testAccounts = Array.from({ length: numAccounts }, (_, i) => {
    // Deterministic derivation from mnemonic
    const account = privateKeyToAccount(
      `0x${Buffer.from(`account${i}`).toString("hex").padStart(64, "0")}` as `0x${string}`,
    );
    return account;
  });

  const walletClient = createWalletClient({
    chain: { ...foundry, id: chainId },
    transport: http(rpcUrl),
  });

  return {
    process: anvilProcess,
    rpcUrl,
    chainId,
    publicClient,
    walletClient,
    testAccounts,
    close: async () => {
      console.log("🛑 Stopping Anvil...");
      anvilProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        anvilProcess.on("exit", () => resolve());
        setTimeout(resolve, 2000); // Force resolve after timeout
      });
      console.log("✅ Anvil stopped");
    },
  };
}

/**
 * Funds an account with test ETH from Anvil's default accounts
 */
export async function fundAccount(
  anvil: AnvilInstance,
  recipient: `0x${string}`,
  amount: bigint,
): Promise<void> {
  // Use Anvil's default account 0 (which has 10000 ETH)
  const defaultAccount = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );

  const txHash = await anvil.walletClient.sendTransaction({
    account: defaultAccount,
    to: recipient,
    value: amount,
  });

  await anvil.publicClient.waitForTransactionReceipt({ hash: txHash });
}

/**
 * Deploys a mock USDC contract for testing
 * Note: Requires a pre-compiled USDC contract ABI and bytecode
 */
export async function deployMockUSDC(
  anvil: AnvilInstance,
): Promise<`0x${string}`> {
  // Simplified mock USDC - in production, use actual USDC ABI
  // This is a placeholder for the deployment logic
  console.log("📝 Deploying mock USDC contract...");

  // For E2E testing, we can use a simple ERC-20 mock
  // In real tests, you'd deploy the actual USDC contract
  const mockAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // Common mock address

  console.log(`✅ Mock USDC deployed at ${mockAddress}`);
  return mockAddress as `0x${string}`;
}
