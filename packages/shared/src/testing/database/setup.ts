/**
 * Test Database Setup & Teardown
 *
 * Centralized database utilities for integration testing.
 * Re-exports from the existing shared test setup to avoid duplicate dependencies.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// Re-export from the existing implementation
export { setupTestDatabase, teardownTestDatabase } from "../../test/setup";
