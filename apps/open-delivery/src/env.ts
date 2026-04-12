/**
 * Server Environment Variables - Open Delivery
 *
 * Validates required environment variables at RUNTIME.
 * During Vercel builds, validation is deferred (env vars aren't available at build time).
 * Uses the shared monorepo env schema to prevent configuration drift.
 *
 * @package @repo/open-delivery
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
    // Open-delivery specific: additional RPCs, routing, driver pay
    POLYGON_RPC_URL: z.string().url().optional(),
    ETHEREUM_RPC_URL: z.string().url().optional(),
    OPENROUTESERVICE_API_KEY: z.string().optional(),
    ORS_ROUTING_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/, "Must be a number")
      .optional(),
    DRIVER_BASE_PAY_CENTS: z
      .string()
      .regex(/^\d+$/, "Must be a number")
      .optional(),
  },

  client: {
    ...sharedClientFields,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(20).optional(),
    NEXT_PUBLIC_MIN_CONFIRMATIONS: z
      .string()
      .regex(/^\d+$/, "Must be a number")
      .optional(),
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // Open-delivery specific runtime mappings
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
    OPENROUTESERVICE_API_KEY: process.env.OPENROUTESERVICE_API_KEY,
    ORS_ROUTING_TIMEOUT_MS: process.env.ORS_ROUTING_TIMEOUT_MS,
    DRIVER_BASE_PAY_CENTS: process.env.DRIVER_BASE_PAY_CENTS,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_MIN_CONFIRMATIONS: process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
