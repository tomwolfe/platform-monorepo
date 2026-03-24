/**
 * Metrics Endpoint - Prometheus Format
 *
 * Exposes application metrics in Prometheus format for scraping.
 * Includes:
 * - Business metrics (reservations, orders, revenue)
 * - Performance metrics (latency, error rate, cache hit rate)
 * - Health check status
 *
 * Usage:
 *   GET /api/metrics
 *
 * Response: Prometheus text format
 *
 * @see Phase 2.3: Monitoring & Alerting
 */

export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { MonitoringService, MetricType } from '@repo/shared';
import { Logger } from '@repo/shared';

const logger = new Logger({ serviceName: 'metrics-api' });

/**
 * Format metric as Prometheus-style metric
 */
function formatPrometheusMetric(name: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `${name}${labelStr} ${value}`;
}

/**
 * GET /api/metrics
 *
 * Returns metrics in Prometheus text format
 */
export async function GET(req: NextRequest) {
  const startTime = Date.now();

  try {
    // Get health status
    const health = await MonitoringService.getHealthStatus();

    // Build Prometheus-format metrics
    const lines: string[] = [
      '# HELP app_uptime Application uptime in seconds',
      '# TYPE app_uptime gauge',
      formatPrometheusMetric('app_uptime', Math.floor(health.uptime)),
      '',
      '# HELP app_health_status Application health status (1=healthy, 0=unhealthy)',
      '# TYPE app_health_status gauge',
      formatPrometheusMetric('app_health_status', health.status === 'healthy' ? 1 : 0),
      '',
    ];

    // Add health check metrics
    for (const check of health.checks) {
      lines.push(
        `# HELP health_check_${check.name} Health check status (1=pass, 0=fail)`,
        '# TYPE health_check_' + check.name + ' gauge',
        formatPrometheusMetric(`health_check_${check.name}`, check.status === 'pass' ? 1 : 0, {
          status: check.status,
        }),
        ''
      );

      if (check.latency !== undefined) {
        lines.push(
          `# HELP health_check_${check.name}_latency_ms Health check latency in milliseconds`,
          '# TYPE health_check_' + check.name + '_latency_ms gauge',
          formatPrometheusMetric(`health_check_${check.name}_latency_ms`, check.latency),
          ''
        );
      }
    }

    // Get performance metrics
    const latencyP50 = await MonitoringService.getPercentile('api_latency', 50);
    const latencyP95 = await MonitoringService.getPercentile('api_latency', 95);
    const latencyP99 = await MonitoringService.getPercentile('api_latency', 99);

    lines.push(
      '# HELP api_latency_p50 API response latency 50th percentile in milliseconds',
      '# TYPE api_latency_p50 gauge',
      formatPrometheusMetric('api_latency_p50', latencyP50),
      '',
      '# HELP api_latency_p95 API response latency 95th percentile in milliseconds',
      '# TYPE api_latency_p95 gauge',
      formatPrometheusMetric('api_latency_p95', latencyP95),
      '',
      '# HELP api_latency_p99 API response latency 99th percentile in milliseconds',
      '# TYPE api_latency_p99 gauge',
      formatPrometheusMetric('api_latency_p99', latencyP99),
      ''
    );

    // Get business metrics
    const reservationsCreated = await MonitoringService.getMetric('reservations_created');
    const reservationsCancelled = await MonitoringService.getMetric('reservations_cancelled');
    const ordersCreated = await MonitoringService.getMetric('orders_created');
    const ordersCompleted = await MonitoringService.getMetric('orders_completed');
    const revenueTotal = await MonitoringService.getMetric('revenue_total');

    lines.push(
      '# HELP reservations_created_total Total number of reservations created',
      '# TYPE reservations_created_total counter',
      formatPrometheusMetric('reservations_created_total', reservationsCreated),
      '',
      '# HELP reservations_cancelled_total Total number of reservations cancelled',
      '# TYPE reservations_cancelled_total counter',
      formatPrometheusMetric('reservations_cancelled_total', reservationsCancelled),
      '',
      '# HELP orders_created_total Total number of delivery orders created',
      '# TYPE orders_created_total counter',
      formatPrometheusMetric('orders_created_total', ordersCreated),
      '',
      '# HELP orders_completed_total Total number of delivery orders completed',
      '# TYPE orders_completed_total counter',
      formatPrometheusMetric('orders_completed_total', ordersCompleted),
      '',
      '# HELP revenue_total_cents Total revenue in USD cents',
      '# TYPE revenue_total_cents counter',
      formatPrometheusMetric('revenue_total_cents', revenueTotal),
      ''
    );

    // Add request duration for this metrics endpoint
    const duration = Date.now() - startTime;
    lines.push(
      '# HELP metrics_request_duration_ms Metrics endpoint request duration',
      '# TYPE metrics_request_duration_ms gauge',
      formatPrometheusMetric('metrics_request_duration_ms', duration),
      ''
    );

    // Return as Prometheus text format
    return new NextResponse(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4',
        'X-Metrics-Timestamp': Date.now().toString(),
      },
    });
  } catch (error) {
    logger.error('Metrics endpoint failed', { error: error instanceof Error ? error.message : String(error) });

    // Return error in Prometheus format
    return new NextResponse(
      '# TYPE app_error gauge\napp_error{type="metrics_endpoint"} 1\n',
      {
        status: 500,
        headers: {
          'Content-Type': 'text/plain; version=0.0.4',
        },
      }
    );
  }
}
