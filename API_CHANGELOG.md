# TableStack API Changelog

All notable changes to the TableStack API are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2024-01-15

### Added
- **Phase 1: Testing Infrastructure**
  - Comprehensive Vitest configuration with coverage thresholds (70% minimum)
  - Unit tests for authentication module (28 tests)
  - Unit tests for Web3 verification (45 tests)
  - Integration tests for API endpoints
  - GitHub Actions CI/CD pipeline with automated testing

- **Phase 1.2: Error Handling & Logging**
  - Centralized error handler with `withApiErrorHandler()` HOC
  - Structured logging with `Logger` class
  - JSON-formatted logs for production
  - Sentry integration for error tracking
  - Standardized error response format

- **Phase 1.3: API Validation & Standardization**
  - Complete Zod schema library for all API endpoints
  - Request validation middleware
  - Standardized API response formatting
  - Type-safe request/response handling

- **Phase 1.4: Security Hardening**
  - CSRF protection middleware
  - Rate limiting on all endpoints (100 req/min default)
  - Input sanitization (HTML stripping, null byte removal)
  - Security headers (CSP, HSTS, X-Frame-Options, etc.)
  - Comprehensive security audit checklist (40+ items)

- **Phase 2.1: Database Optimization & Caching**
  - 20+ database indexes for performance
  - Redis caching middleware with tag-based invalidation
  - Query performance monitoring
  - N+1 query prevention with `batchLoad()`
  - Cache warming utilities

- **Phase 2.2: API Documentation**
  - Complete OpenAPI 3.1 specification
  - Interactive API documentation
  - API examples for all endpoints
  - Authentication flow documentation

### Changed
- **Breaking**: Removed `db` proxy export, use `getDb()` function instead
- Improved error messages with more context
- Enhanced rate limiting with Redis backend
- Updated JWT verification to prefer RS256 asymmetric keys

### Deprecated
- API key authentication (migrate to JWT bearer tokens)
- Legacy error response format (use standardized format)

### Removed
- Duplicate export statements causing build issues
- Unused sandbox modules (incompatible with Edge runtime)

### Fixed
- Race conditions in reservation creation
- Cross-user idempotency blocking
- Memory leaks in test cleanup
- Cache invalidation for tagged keys

### Security
- Added CSRF protection for all state-changing operations
- Implemented replay prevention for Web3 transactions
- Added input sanitization to prevent XSS attacks
- Enhanced JWT validation with audience/issuer checks

## [1.5.0] - 2024-01-01

### Added
- Web3 payment support (ETH, USDC, USDT)
- On-chain transaction verification
- Treasury wallet integration
- Crypto payment speed-up mechanism

### Changed
- Updated viem to v2.x
- Migrated to Base network for payments

## [1.4.0] - 2023-12-15

### Added
- Real-time updates via Ably
- Nervous System Observer for event mesh
- Waitlist management with notifications

### Fixed
- Table combination logic for large parties
- Timezone handling for reservations

## [1.3.0] - 2023-12-01

### Added
- Shadow restaurant profiles
- Passive booking flow
- Owner claim invitations

## [1.2.0] - 2023-11-15

### Added
- Guest profile tracking
- High-value guest alerts
- Visit count tracking

## [1.1.0] - 2023-11-01

### Added
- Table availability checking
- Alternative time slot suggestions
- Restaurant hours validation

## [1.0.0] - 2023-10-15

### Added
- Initial release
- Reservation creation and management
- Email verification flow
- Basic restaurant management
- API key authentication

---

## Migration Guides

### Migrating to v2.0.0

#### Database Access
```typescript
// Before (removed)
import { db } from '@repo/database';
const users = await db.select().from(users);

// After
import { getDb } from '@repo/database';
const db = getDb();
const users = await db.select().from(users);
```

#### Error Handling
```typescript
// Before
try {
  // ...
} catch (error) {
  return Response.json({ error: error.message }, { status: 500 });
}

// After
import { withApiErrorHandler } from '@repo/shared';

export const POST = withApiErrorHandler(async (req) => {
  // Your handler logic
  throw new ValidationError('Invalid input');
});
```

#### Authentication
```typescript
// Before (API key only)
const apiKey = req.headers.get('x-api-key');

// After (JWT preferred)
const authHeader = req.headers.get('authorization');
if (authHeader?.startsWith('Bearer ')) {
  const token = authHeader.substring(7);
  // Verify JWT token
}
```

### API Deprecation Timeline

| Feature | Deprecated | Sunset | Replacement |
|---------|------------|--------|-------------|
| API Key Auth | 2024-01-15 | 2024-07-01 | JWT Bearer Token |
| Legacy Error Format | 2024-01-15 | 2024-04-01 | Standardized Format |
| v1 API (unversioned) | 2024-01-15 | 2024-07-01 | /api/v2/* |

---

## Support

For migration assistance or questions:
- Email: support@tablestack.io
- Documentation: https://docs.tablestack.io
- Status: https://status.tablestack.io
