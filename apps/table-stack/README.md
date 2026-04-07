# TableStack

TableStack is a restaurant management application for floor planning, reservations, and waitlist management.

## Authentication

TableStack uses a **Zero-Trust JWT authentication model** with multiple verification methods in priority order.

### Authentication Priority

1. **RS256 Asymmetric JWT** (Preferred - Public key verification)
2. **Scoped JWT** (Tool-level permissions)
3. **HS256 Service Token** (⚠️ **DEPRECATED** - Migration fallback only)
4. **API Key** (Legacy external clients only, rate-limited)

### RS256 Asymmetric JWT (Recommended)

All new services should use RS256 asymmetric JWTs for service-to-service communication. This method uses public/private key pairs and eliminates the need for shared secrets.

```typescript
// Example: Creating an RS256 JWT
import { signAsymmetricJWT } from '@repo/auth';

const token = await signAsymmetricJWT({
  iss: 'intention-engine',
  sub: 'table-stack',
  restaurantId: 'restaurant-uuid',
  traceId: 'trace-uuid',
});

// Use in requests
fetch('/api/v1/availability', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### ⚠️ HS256 Deprecation Notice

**HS256 service token verification is deprecated** and will be removed in a future release. All services currently using HS256 should migrate to RS256 asymmetric JWTs.

#### Why migrate?
- **No shared secrets**: RS256 uses public/private key pairs
- **Better security**: Asymmetric cryptography is more resistant to key compromise
- **Future-proof**: HS256 verification will be removed entirely

#### Migration steps:
1. Update your service to use `signAsymmetricJWT` instead of `signServiceToken`
2. Use the RS256 public key for verification
3. Test in staging before deploying to production
4. Remove HS256 token generation from your service

### API Keys (Legacy)

API keys are still supported for external clients (e.g., third-party integrations) but are rate-limited to 100 requests per 60 seconds per IP.

```bash
curl -H "x-api-key: ts_your_api_key" \
  "https://tablestack.example.com/api/v1/availability?restaurantId=uuid&date=2026-04-07&partySize=4"
```

## Environment Variables

Required environment variables:

```env
DATABASE_URL=postgresql://...
UPSTASH_REDIS_REST_URL=https://...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

## Development

```bash
# Install dependencies
pnpm install

# Generate database schema
pnpm db:generate

# Run development server
pnpm dev

# Run tests
pnpm test
```

## API Documentation

OpenAPI specification is available at `/api/docs/openapi.json` when the server is running.

## Architecture

TableStack is part of the Apps Monorepo and uses:
- **Next.js 15** (App Router)
- **Drizzle ORM** (PostgreSQL)
- **Redis** (Caching, rate limiting, idempotency)
- **Ably** (Real-time event streaming)
- **Clerk** (User authentication)
