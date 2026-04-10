/**
 * Domain-Specific HTTP Error Classes
 *
 * Extends AppError with standardized properties for common error scenarios.
 * All errors include `statusCode` and `code` for consistent handling.
 *
 * NOTE: These are aliases to the canonical error classes in ../errors
 * Exported here for convenient imports from @repo/shared/http
 *
 * @package @repo/shared
 */

// Re-export canonical error classes from parent module
export {
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
} from "../errors";
