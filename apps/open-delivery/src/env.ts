/**
 * Server Environment Variables - Open Delivery
 *
 * Validates required environment variables at BUILD TIME.
 * This file is imported in next.config.mjs to fail fast during `next build`.
 *
 * @package @repo/open-delivery
 */

import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    // Database
    DATABASE_URL: z.string().url("Must be a valid PostgreSQL URL"),

    // Authentication
    CLERK_SECRET_KEY: z.string().min(20, "Must be a valid Clerk secret key"),
    INTERNAL_SYSTEM_KEY: z
      .string()
      .length(64, "Must be exactly 64 characters (32 bytes in hex)")
      .regex(/^[0-9a-fA-F]+$/, "Must be a valid hex string"),

    // Async Workflows
    QSTASH_TOKEN: z.string().min(10, "Must be a valid QStash token"),

    // Cron Secret for scheduled jobs
    CRON_SECRET: z.string().min(16, "Must be a strong secret (min 16 chars)"),

    // Web3 / Blockchain
    BASE_RPC_URL: z.string().url("Must be a valid RPC URL"),

    // Ably Real-time
    ABLY_API_KEY: z.string().optional(),

    // Optional: Redis for caching
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // Optional: OpenAI for AI features
    OPENAI_API_KEY: z.string().optional(),

    // Optional: Escrow resolver private key
    ESCROW_RESOLVER_PRIVATE_KEY: z.string().optional(),

    // Node environment
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(20).optional(),
    NEXT_PUBLIC_USDC_CONTRACT_ADDRESS: z
      .string()
      .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
      .optional(),
    NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS: z
      .string()
      .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
      .optional(),
    NEXT_PUBLIC_PLATFORM_FEE_WALLET: z
      .string()
      .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
      .optional(),
  },

  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    INTERNAL_SYSTEM_KEY: process.env.INTERNAL_SYSTEM_KEY,
    QSTASH_TOKEN: process.env.QSTASH_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
    BASE_RPC_URL: process.env.BASE_RPC_URL,
    ABLY_API_KEY: process.env.ABLY_API_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ESCROW_RESOLVER_PRIVATE_KEY: process.env.ESCROW_RESOLVER_PRIVATE_KEY,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_USDC_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS,
    NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS,
    NEXT_PUBLIC_PLATFORM_FEE_WALLET:
      process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
