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

export const env = createEnv({
  server: {
    ...sharedServerFields,
    // No open-delivery-specific server vars required (now in shared)
  },

  client: {
    ...sharedClientFields,
    // No open-delivery-specific client vars required (now in shared)
  },

  runtimeEnv: {
    ...sharedRuntimeEnv,
    // No open-delivery-specific runtime mappings required
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
