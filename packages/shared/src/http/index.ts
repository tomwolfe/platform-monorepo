/**
 * HTTP Utilities - Unified Response Factory
 *
 * Standardized error classes, response factories, and API handler wrappers.
 * Ensures consistent API response shapes across all Next.js route handlers.
 *
 * @package @repo/shared
 */

export {
  // Response factories
  successResponse,
  errorResponse,
  formatZodError,

  // Next.js response helpers
  jsonSuccess,
  jsonError,
} from "./responses";

export {
  // Error classes
  ValidationError,
  // Auth errors
  UnauthorizedError,
  InvalidTokenError,
  TokenExpiredError,
  ForbiddenError,
  // Resource errors
  NotFoundError,
  ConflictError,
  AlreadyExistsError,
  // Service errors
  ServiceUnavailableError,
  RateLimitError,
  ExternalServiceError,
} from "./errors";
