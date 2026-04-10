# Authentication Flow Documentation

## Overview

This monorepo uses a **unified authentication gateway** (`@repo/shared/auth/gateway`) that checks authentication methods in order of precedence. All API routes should use `validateRequest()` from the gateway rather than implementing auth checks inline.

## Auth Precedence Order

The gateway checks auth methods in this order. The **first successful match** wins:

| Priority | Method               | Header                          | Use Case                                         |
| -------- | -------------------- | ------------------------------- | ------------------------------------------------ |
| 1        | Bearer JWT           | `Authorization: Bearer <token>` | Zero-Trust, external clients, scoped permissions |
| 2        | Internal Key         | `x-internal-key: <key>`         | Service-to-service communication                 |
| 3        | API Key (deprecated) | `x-api-key: <key>`              | Legacy clients (being phased out)                |

### 1. Bearer JWT (Preferred)

**Type:** Asymmetric RS256 JWT (Zero-Trust model)

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

- **Verification:** Uses public key infrastructure (PKI) via `SecurityProvider.verifyAsymmetricJWT()`
- **Fallback:** If asymmetric verification fails, tries scoped JWT via `SecurityProvider.verifyScopedJWT()`
- **Context returned:** `resourceId`, `isInternal`, `scopedPermissions`, `jwtPayload`
- **Use for:** User-facing APIs, Clerk-authenticated routes, third-party integrations

#### Scoped JWT Permissions

JWTs can include tool-level permissions for fine-grained access control:

```json
{
  "sub": "user_123",
  "permissions": {
    "tools": ["check_availability", "book_reservation"],
    "restaurants": ["rest_456"]
  }
}
```

### 2. Internal Key (Service-to-Service)

**Type:** Shared secret (64-char hex string)

```
x-internal-key: a1b2c3d4e5f6...
```

- **Verification:** Timing-safe string comparison against `INTERNAL_SYSTEM_KEY` env var
- **Context returned:** `isInternal: true`
- **Use for:** Internal microservice calls, cron jobs, webhook callbacks
- **Generate:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 3. API Key (Deprecated)

**Type:** Legacy shared secret

```
x-api-key: some-api-key
```

- **Status:** ⚠️ **DEPRECATED** — logs warning on every use
- **Verification:** Accepts any non-empty value (temporary)
- **Timeline:** Will be removed in Q2 2026
- **Migration:** Clients should switch to Bearer JWT or `x-internal-key`

## Key Rotation

### Internal System Key

1. Generate new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Deploy new key to all services via environment variable `INTERNAL_SYSTEM_KEY`
3. All services verify the new key immediately (no rotation window needed — it's a single shared secret)

### JWT Keys (Asymmetric)

1. Generate new RSA key pair
2. Register new public key in the key registry
3. Sign with new private key
4. Old public keys remain valid for verification during transition
5. Remove old public keys after all tokens have expired

## Usage in Route Handlers

```typescript
import {
  validateRequest,
  withApiErrorHandler,
  formatApiError,
} from "@repo/shared";

export const POST = withApiErrorHandler(async (req) => {
  const { error, status, context } = await validateRequest(req);
  if (error) {
    return NextResponse.json(formatApiError(new Error(error), "UNAUTHORIZED"), {
      status,
    });
  }

  // Handler logic with context.resourceId, context.isInternal, etc.
});
```

## Security Notes

- All auth methods are checked **server-side only** — no client-side auth logic
- Timing-safe comparison for internal keys prevents timing attacks
- JWT verification uses asymmetric keys — private key never leaves the signer
- Failed auth attempts are logged with trace ID for audit trails
- Deprecated `x-api-key` usage generates warnings for migration tracking
