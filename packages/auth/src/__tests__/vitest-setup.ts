/**
 * Vitest Setup for @repo/auth Tests
 *
 * Generates test RSA key pair for asymmetric JWT tests.
 * In production, these keys should be stored in environment variables.
 */

import { generateKeyPair, exportSPKI, exportPKCS8 } from "jose";
import { registerPublicKey } from "../asymmetric-jwt";

// Generate test key pair before tests run
async function setupTestKeys() {
  // Only set if not already defined (to allow CI to override)
  if (!process.env.INTENTION_ENGINE_PRIVATE_KEY) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });

    const privateKeyPEM = await exportPKCS8(privateKey);
    const publicKeyPEM = await exportSPKI(publicKey);

    process.env.INTENTION_ENGINE_PRIVATE_KEY = privateKeyPEM;

    // Register the public key for runtime lookup under "internal-service" issuer
    registerPublicKey("internal-service", publicKeyPEM);

    // Also register for common test issuers
    registerPublicKey("test-service", publicKeyPEM);
  }
}

setupTestKeys().catch(console.error);
