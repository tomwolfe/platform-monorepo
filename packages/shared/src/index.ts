// ============================================================================
// SHARED PACKAGE - MAIN EXPORTS (SERVER-ONLY BY DEFAULT)
//
// ⚠️  WARNING: This is the DEFAULT import path for @repo/shared.
//     It exports SERVER-ONLY modules (Redis, QStash, Ably, Drizzle).
//
//     Importing from '@repo/shared' in client components WILL bloat
//     your client bundle with server dependencies.
//
// ✅ CORRECT IMPORT PATHS:
//   - Client components / Edge runtime: import { ... } from '@repo/shared/client'
//   - Isomorphic utilities: import { ... } from '@repo/shared/shared'
//   - Server API routes / Server actions: import { ... } from '@repo/shared/server'
//
// ============================================================================

// Enforce server-only usage in Next.js client components
import "server-only";

// Re-export all server modules for backward compatibility
export * from "./server";

// ============================================================================
// DEPRECATED DIRECT EXPORTS (Use explicit paths instead)
// ============================================================================
// These exports remain for backward compatibility but should NOT be used.
// Migrate to '@repo/shared/client', '@repo/shared/shared', or '@repo/shared/server'.
//
// NOTE: All exports are now available via:
//   - @repo/shared/client (browser-safe)
//   - @repo/shared/shared (isomorphic, Edge/Node)
//   - @repo/shared/server (Node.js only)
//
// The main '@repo/shared' import now imports everything from server
// for backward compatibility, but new code should use explicit paths.
