/**
 * Health Check Endpoint
 * 
 * Returns the health status of the Table Stack service.
 * Used by Kubernetes liveness probes and load balancers.
 * 
 * @see https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
 */

import { createHealthHandler } from '@repo/shared/health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = createHealthHandler({ verbose: false });
