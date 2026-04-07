# ADR-0002: Zero-Trust Authentication with RS256

**Status:** Accepted  
**Date:** 2026-01-20  
**Deciders:** Engineering Team, Security Team  
**Context:** Authentication & Authorization

## Technical Story

The system initially used HS256 (symmetric HMAC) JWTs for authentication. As the architecture evolved to include multiple apps (Intention Engine, TableStack, OpenDelivery) and external services (QStash webhooks, MCP tools), we needed a more robust authentication model that follows zero-trust principles.

## Decision Drivers

- **Security:** Prevent unauthorized access to internal APIs and services
- **Multi-Service Architecture:** Different services need to verify tokens independently
- **Key Rotation:** Ability to rotate signing keys without service disruption
- **Asymmetric Trust:** Services should verify tokens without having signing capability
- **Webhook Verification:** QStash and external webhooks need cryptographic proof of origin

## Considered Options

### Option 1: HS256 (Symmetric HMAC)
**Pros:**
- Simple implementation
- Fast verification
- Single shared secret

**Cons:**
- **Security Risk:** Any service with the secret can forge tokens
- **Key Rotation:** Requires coordinated downtime across all services
- **No Non-Repudiation:** Cannot prove which service created a token
- **Blast Radius:** Compromised secret affects all services

### Option 2: RS256 (Asymmetric RSA) - Selected
**Pros:**
- **Zero-Trust Model:** Public key distribution without signing capability
- **Key Rotation:** Graceful rotation with overlapping key validity periods
- **Non-Repudiation:** Only private key holder can create tokens
- **Service Isolation:** Compromised service cannot forge tokens for other services
- **Webhook Security:** External services can sign requests that we verify with their public key

**Cons:**
- Slightly more complex key management
- Marginally slower verification (negligible in practice)
- Requires PKI infrastructure (Clerk handles this)

### Option 3: mTLS (Mutual TLS)
**Pros:**
- Strong cryptographic identity for services
- Encrypted transport layer

**Cons:**
- Complex certificate management
- Not suitable for browser-based clients
- Overkill for stateless API authentication

## Decision

**We adopted RS256** with Clerk as the identity provider, implementing asymmetric JWT verification across all services.

### Architecture

```
┌─────────────────┐
│   Clerk (IdP)   │  ← Signs tokens with RS256 private key
│                 │
│  Private Key    │  🔒 Never leaves Clerk
│  Public Key     │  🌐 Distributed via JWKS endpoint
└────────┬────────┘
         │
         │ Signs tokens
         ▼
┌─────────────────┐
│   Client/Browser │  ← Receives JWT signed by Clerk
└────────┬────────┘
         │
         │ Presents token
         ▼
┌─────────────────────────────────────────────┐
│  Application Services (Engine, TableStack)  │
│                                              │
│  1. Fetch JWKS from Clerk                   │
│  2. Verify token signature with public key  │
│  3. Validate claims (exp, aud, iss)         │
│  4. Extract user identity                   │
└─────────────────────────────────────────────┘
```

### Implementation

```typescript
// @repo/auth - Centralized auth utilities
import { clerkClient } from '@clerk/nextjs/server';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: `${process.env.CLERK_ISSUER_URL}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600_000, // 10 minutes
});

export async function verifyToken(token: string): Promise<JwtPayload> {
  // Get signing key from JWKS
  const signingKey = await client.getSigningKey();
  const publicKey = signingKey.getPublicKey();

  // Verify with RS256
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: process.env.CLERK_ISSUER_URL,
    audience: process.env.CLERK_AUDIENCE,
  });
}
```

### Key Rotation Strategy

Clerk handles key rotation automatically:
1. New key pair generated periodically
2. Public key published to JWKS endpoint
3. Old key remains valid during transition period (24h overlap)
4. Services fetch latest key via JWKS with caching

### QStash Webhook Verification

QStash uses ED25519 for webhook signatures (separate from RS256):

```typescript
import { verifyQStashWebhook } from '@repo/shared/services/qstash-webhook';

export const POST = async (request: NextRequest) => {
  const rawBody = await request.text();
  const signature = request.headers.get('upstash-signature');
  
  const isValid = await verifyQStashWebhook(rawBody, signature);
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  // Process webhook
};
```

## Consequences

### Positive
- ✅ Zero-trust architecture: services verify without signing capability
- ✅ Graceful key rotation without downtime
- ✅ Reduced blast radius from key compromise
- ✅ Cryptographic proof of webhook origin (QStash, external integrations)
- ✅ Compliance with modern security best practices

### Negative
- ⚠️ Slightly more complex initial setup
- ⚠️ Dependency on Clerk's JWKS endpoint availability (mitigated by caching)
- ⚠️ Additional network call for key fetching (mitigated by 10-minute cache)

### Mitigations
- JWKS caching prevents repeated network calls
- Fallback to cached keys if JWKS endpoint unavailable
- Comprehensive logging of authentication failures
- Rate limiting on auth endpoints to prevent brute-force attacks

## Related Decisions

- [ADR-0001](0001-saga-architecture.md): QStash webhook authentication
- [ADR-0003](0003-occ-rebase.md): State machine authorization with user context
