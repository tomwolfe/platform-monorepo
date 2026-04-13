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

export const env = createEnv({
  server: {
    ...sharedServerFields,
    // No intention-engine-specific server vars required (now in shared)
  },

  client: {
    ...sharedClientFields,
    // No intention-engine-specific client vars required (now in shared)
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // No intention-engine-specific runtime mappings required
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
