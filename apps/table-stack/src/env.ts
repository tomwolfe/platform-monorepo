/**
 * Server Environment Variables - Table Stack
 *
 * Validates required environment variables at BUILD TIME.
 * Uses the shared monorepo env schema to prevent configuration drift.
 *
 * @package @repo/table-stack
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
    // Add any table-stack-only server vars here
  },

  client: {
    ...sharedClientFields,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(20).optional(),
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // Table-stack specific runtime mappings
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
