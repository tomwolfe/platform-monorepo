/**
 * Prometheus Metrics Endpoint
 *
 * Serves Prometheus-compatible metrics for monitoring.
 * Access at: /api/metrics
 *
 * @see Phase 3.1: Monitoring & Alerting
 */

export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { metrics } from '@repo/shared';

export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get('format') || 'prometheus';

  if (format !== 'prometheus') {
    return NextResponse.json(
      { error: 'Only Prometheus format is supported' },
      { status: 400 }
    );
  }

  const metricsText = await metrics.getMetrics();

  return new NextResponse(metricsText, {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4',
      'Cache-Control': 'no-cache',
    },
  });
}
