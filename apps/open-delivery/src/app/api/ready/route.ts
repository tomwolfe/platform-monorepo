/**
 * Readiness Check Endpoint
 * 
 * Returns whether the Open Delivery service is ready to receive traffic.
 * Used by Kubernetes readiness probes.
 */

import { createReadyHandler } from '@repo/shared/health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = createReadyHandler();
