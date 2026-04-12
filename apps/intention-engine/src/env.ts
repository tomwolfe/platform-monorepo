/**
 * Server Environment Variables - Intention Engine
 *
 * Validates required environment variables at RUNTIME.
 * During Vercel builds, validation is deferred (env vars aren't available at build time).
 * Uses the shared monorepo env schema to prevent configuration drift.
 *
 * @package @repo/intention-engine
 */

import { createEnv } from "@t3-oss/env-nextjs";
import {
  sharedServerFields,
  sharedClientFields,
  sharedRuntimeEnv,
} from "@repo/shared/config/env-shared";
import { z } from "zod";

export const env = createEnv({
  server: {
    ...sharedServerFields,
    // Engine-specific: vector search, MCP servers
    UPSTASH_VECTOR_URL: z.string().url().optional(),
    UPSTASH_VECTOR_TOKEN: z.string().optional(),
    HUGGINGFACE_API_KEY: z.string().optional(),
    INTENTION_ENGINE_PRIVATE_KEY: z.string().optional(),
  },

  client: {
    ...sharedClientFields,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(20).optional(),
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // Intention-engine specific runtime mappings
    UPSTASH_VECTOR_URL: process.env.UPSTASH_VECTOR_URL,
    UPSTASH_VECTOR_TOKEN: process.env.UPSTASH_VECTOR_TOKEN,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    INTENTION_ENGINE_PRIVATE_KEY: process.env.INTENTION_ENGINE_PRIVATE_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
