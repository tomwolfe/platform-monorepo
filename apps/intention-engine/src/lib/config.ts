/**
 * Intention Engine Configuration
 *
 * Re-exports from @repo/shared for backward compatibility.
 * New code should use AppConfig directly from @repo/shared.
 */

import { AppConfig, BaseConfigSchema } from "@repo/shared";
import { z } from "zod";

/**
 * Extended schema for intention-engine specific settings
 */
const IntentionEngineSchema = BaseConfigSchema.extend({
  // Add any intention-engine specific config here
});

/**
 * @deprecated Use AppConfig directly instead
 */
export const env = AppConfig.getAll();

/**
 * Re-export AppConfig for direct usage
 */
export { AppConfig };
