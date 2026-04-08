/**
 * Health Check Endpoint
 *
 * Returns the health status of the Open Delivery service.
 * Used by Kubernetes liveness probes and load balancers.
 */

import { createHealthHandler } from "@repo/shared/health";

export const dynamic = "force-dynamic";

export const GET = createHealthHandler({ verbose: false });
