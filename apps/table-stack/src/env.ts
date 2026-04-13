/**
 * Server Environment Variables - Table Stack
 *
 * Validates required environment variables at RUNTIME.
 * During Vercel builds, validation is deferred (env vars aren't available at build time).
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
    // No table-stack-specific server vars required
  },

  client: {
    ...sharedClientFields,
    // No table-stack-specific client vars required
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // No table-stack-specific runtime mappings required
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
