/**
 * Open Delivery Environment Configuration
 *
 * Re-exports from @repo/shared for backward compatibility.
 * New code should use AppConfig directly from @repo/shared.
 */

import { AppConfig } from "@repo/shared";

/**
 * @deprecated Use AppConfig.getTableStackApiUrl() instead
 */
export const getTableStackApiUrl = () => AppConfig.getTableStackApiUrl();

/**
 * @deprecated Use AppConfig.getInternalSystemKey() instead
 */
export const getInternalSystemKey = () => AppConfig.getInternalSystemKey();

/**
 * Re-export AppConfig for direct usage
 */
export { AppConfig };
