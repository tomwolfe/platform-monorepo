/**
 * Readiness Check Endpoint
 * 
 * Returns whether the Table Stack service is ready to receive traffic.
 * Used by Kubernetes readiness probes.
 * 
 * Unlike the health check, this verifies that all critical dependencies
 * (database, Redis) are available and the service can handle requests.
 */

import { createReadyHandler } from '@repo/shared/health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = createReadyHandler();
