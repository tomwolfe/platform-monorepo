/**
 * Monitoring & Alerting Service
 *
 * Comprehensive monitoring for application health, performance, and business metrics.
 * Provides:
 * - Custom metrics collection
 * - Alert threshold monitoring
 * - Health check aggregation
 * - Performance tracking
 * - Error rate monitoring
 *
 * Usage:
 * ```typescript
 * import { MonitoringService, AlertLevel } from '@repo/shared';
 *
 * // Track business metric
 * await MonitoringService.incrementMetric('reservations_created', { restaurantId: '123' });
 *
 * // Track latency
 * await MonitoringService.trackLatency('reservation_flow', durationMs);
 *
 * // Send alert
 * await MonitoringService.sendAlert('High error rate detected', AlertLevel.CRITICAL);
 * ```
 *
 * @see Phase 2.3: Monitoring & Alerting
 */

import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";
import { CACHE_TIERS } from "../config/cache-tiers";
import { QStashService } from "./qstash";

const redis = getRedisClient(ServiceNamespace.SHARED);

// ============================================================================
// TYPES
// ============================================================================

export enum AlertLevel {
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
}

export enum MetricType {
  COUNTER = "counter",
  GAUGE = "gauge",
  HISTOGRAM = "histogram",
  TIMER = "timer",
}

export interface MetricDefinition {
  name: string;
  type: MetricType;
  description: string;
  unit?: string;
  labels?: string[];
}

export interface AlertConfig {
  name: string;
  metric: string;
  threshold: number;
  operator: ">" | ">=" | "<" | "<=" | "==";
  windowSeconds: number;
  alertLevel: AlertLevel;
  message: string;
  cooldownSeconds?: number;
}

export interface Alert {
  id: string;
  name: string;
  level: AlertLevel;
  message: string;
  metricValue: number;
  threshold: number;
  timestamp: string;
  resolved?: boolean;
  resolvedAt?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheck[];
  timestamp: string;
  uptime: number;
}

export interface HealthCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message?: string;
  latency?: number;
  timestamp: string;
}

// ============================================================================
// PREDEFINED METRICS
// ============================================================================

export const BUSINESS_METRICS: MetricDefinition[] = [
  {
    name: "reservations_created",
    type: MetricType.COUNTER,
    description: "Total number of reservations created",
  },
  {
    name: "reservations_cancelled",
    type: MetricType.COUNTER,
    description: "Total number of reservations cancelled",
  },
  {
    name: "orders_created",
    type: MetricType.COUNTER,
    description: "Total number of delivery orders created",
  },
  {
    name: "orders_completed",
    type: MetricType.COUNTER,
    description: "Total number of delivery orders completed",
  },
  {
    name: "active_users",
    type: MetricType.GAUGE,
    description: "Number of currently active users",
  },
  {
    name: "revenue_total",
    type: MetricType.COUNTER,
    description: "Total revenue in USD cents",
    unit: "cents",
  },
];

export const PERFORMANCE_METRICS: MetricDefinition[] = [
  {
    name: "api_latency_p50",
    type: MetricType.HISTOGRAM,
    description: "API response latency 50th percentile",
    unit: "ms",
  },
  {
    name: "api_latency_p95",
    type: MetricType.HISTOGRAM,
    description: "API response latency 95th percentile",
    unit: "ms",
  },
  {
    name: "api_latency_p99",
    type: MetricType.HISTOGRAM,
    description: "API response latency 99th percentile",
    unit: "ms",
  },
  {
    name: "db_query_latency",
    type: MetricType.HISTOGRAM,
    description: "Database query latency",
    unit: "ms",
  },
  {
    name: "cache_hit_rate",
    type: MetricType.GAUGE,
    description: "Cache hit rate percentage",
    unit: "%",
  },
  {
    name: "error_rate",
    type: MetricType.GAUGE,
    description: "Error rate percentage",
    unit: "%",
  },
];

// ============================================================================
// PREDEFINED ALERTS
// ============================================================================

export const DEFAULT_ALERTS: AlertConfig[] = [
  {
    name: "high_error_rate",
    metric: "error_rate",
    threshold: 5,
    operator: ">",
    windowSeconds: 300, // 5 minutes
    alertLevel: AlertLevel.CRITICAL,
    message: "Error rate exceeded 5% in the last 5 minutes",
    cooldownSeconds: 600,
  },
  {
    name: "high_latency_p95",
    metric: "api_latency_p95",
    threshold: 1000,
    operator: ">",
    windowSeconds: 300,
    alertLevel: AlertLevel.WARNING,
    message: "P95 latency exceeded 1 second",
    cooldownSeconds: 300,
  },
  {
    name: "high_latency_p99",
    metric: "api_latency_p99",
    threshold: 2000,
    operator: ">",
    windowSeconds: 300,
    alertLevel: AlertLevel.CRITICAL,
    message: "P99 latency exceeded 2 seconds",
    cooldownSeconds: 300,
  },
  {
    name: "low_cache_hit_rate",
    metric: "cache_hit_rate",
    threshold: 50,
    operator: "<",
    windowSeconds: 600,
    alertLevel: AlertLevel.WARNING,
    message: "Cache hit rate below 50%",
    cooldownSeconds: 900,
  },
  {
    name: "reservation_spike",
    metric: "reservations_created",
    threshold: 100,
    operator: ">",
    windowSeconds: 300,
    alertLevel: AlertLevel.INFO,
    message: "Unusual spike in reservations (>100 in 5 minutes)",
    cooldownSeconds: 600,
  },
];

// ============================================================================
// MONITORING SERVICE
// ============================================================================

export class MonitoringServiceClass {
  private logger: Logger;
  private metricsPrefix = "monitoring:metrics:";
  private alertsPrefix = "monitoring:alerts:";
  private initialized = false;

  constructor() {
    this.logger = new Logger({ serviceName: "monitoring" });
  }

  /**
   * Initialize monitoring service
   * Registers metrics and starts alert monitoring
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Register all predefined metrics
    await this.registerMetrics([...BUSINESS_METRICS, ...PERFORMANCE_METRICS]);

    // Register all predefined alerts
    await this.registerAlerts(DEFAULT_ALERTS);

    // Start alert monitoring loop
    this.startAlertMonitoring();

    this.initialized = true;
    this.logger.info("Monitoring service initialized");
  }

  // ============================================================================
  // METRIC COLLECTION
  // ============================================================================

  /**
   * Register a metric definition
   */
  async registerMetrics(metrics: MetricDefinition[]): Promise<void> {
    const client = redis;
    for (const metric of metrics) {
      const key = `${this.metricsPrefix}def:${metric.name}`;
      await client.hset(key, {
        name: metric.name,
        type: metric.type,
        description: metric.description,
        unit: metric.unit || "",
        labels: metric.labels ? JSON.stringify(metric.labels) : "",
      });
    }
  }

  /**
   * Increment a counter metric
   */
  async incrementMetric(
    name: string,
    value: number = 1,
    labels?: Record<string, string>,
  ): Promise<void> {
    const client = redis;
    const key = this.getMetricKey(name, labels);
    await client.incrby(key, value);

    // Also track in time series (for windowed queries)
    const timestamp = Date.now();
    const windowKey = `${this.metricsPrefix}series:${name}:${Math.floor(timestamp / 60000)}`; // 1-minute windows
    await client.zadd(windowKey, {
      score: timestamp,
      value: JSON.stringify({ value, timestamp, labels }),
    });
    await client.expire(windowKey, 3600); // Keep 1 hour of data

    this.logger.debug("Metric incremented", { name, value, labels });
  }

  /**
   * Set a gauge metric
   */
  async setGauge(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): Promise<void> {
    const client = redis;
    const key = this.getMetricKey(name, labels);
    // DB-01: Add explicit TTL to prevent memory bloat
    await client.set(key, value.toString(), { ex: CACHE_TIERS.EXTENDED });

    this.logger.debug("Gauge set", { name, value, labels });
  }

  /**
   * Track latency (histogram)
   */
  async trackLatency(
    name: string,
    latencyMs: number,
    labels?: Record<string, string>,
  ): Promise<void> {
    const client = redis;
    const key = `${this.metricsPrefix}histogram:${name}`;

    // Add to sorted set for percentile calculations
    await client.zadd(key, {
      score: latencyMs,
      value: `${Date.now()}:${latencyMs}`,
    });

    // Keep only last 10000 samples
    await client.zremrangebyrank(key, 0, -10001);

    // Also set as gauge for current value
    await this.setGauge(`${name}_current`, latencyMs, labels);

    this.logger.debug("Latency tracked", { name, latencyMs, labels });
  }

  /**
   * Get metric value
   */
  async getMetric(
    name: string,
    labels?: Record<string, string>,
  ): Promise<number> {
    const client = redis;
    const key = this.getMetricKey(name, labels);
    const value = await client.get(key);
    return value ? parseFloat(value) : 0;
  }

  /**
   * Get metric with time window aggregation
   */
  async getMetricWindow(
    name: string,
    windowSeconds: number = 300,
  ): Promise<{
    sum: number;
    count: number;
    avg: number;
    min: number;
    max: number;
  }> {
    const client = redis;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    // Get all 1-minute windows in the range
    const startMinute = Math.floor(windowStart / 60000);
    const endMinute = Math.floor(now / 60000);

    const values: number[] = [];

    for (let minute = startMinute; minute <= endMinute; minute++) {
      const windowKey = `${this.metricsPrefix}series:${name}:${minute}`;
      const data = await client.zrange(windowKey, 0, -1);

      for (const item of data) {
        try {
          const parsed = JSON.parse(item);
          if (parsed.timestamp >= windowStart) {
            values.push(parsed.value);
          }
        } catch {
          // Skip invalid data
        }
      }
    }

    if (values.length === 0) {
      return { sum: 0, count: 0, avg: 0, min: 0, max: 0 };
    }

    return {
      sum: values.reduce((a, b) => a + b, 0),
      count: values.length,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  /**
   * Calculate percentile from histogram
   */
  async getPercentile(name: string, percentile: number): Promise<number> {
    const client = redis;
    const key = `${this.metricsPrefix}histogram:${name}`;

    // Get all values
    const values = await client.zrange(key, 0, -1, "WITHSCORES");

    if (!values || values.length === 0) {
      return 0;
    }

    // Extract scores (latencies)
    const latencies = values
      .filter((_, i) => i % 2 === 1) // Get scores (odd indices)
      .map((v) => parseFloat(String(v)))
      .sort((a, b) => a - b);

    // Calculate percentile
    const index = Math.ceil((percentile / 100) * latencies.length) - 1;
    return latencies[Math.max(0, index)];
  }

  // ============================================================================
  // ALERT MANAGEMENT
  // ============================================================================

  /**
   * Register alert configurations
   */
  async registerAlerts(alerts: AlertConfig[]): Promise<void> {
    const client = redis;
    for (const alert of alerts) {
      const key = `${this.alertsPrefix}config:${alert.name}`;
      await client.hset(key, {
        name: alert.name,
        metric: alert.metric,
        threshold: alert.threshold.toString(),
        operator: alert.operator,
        windowSeconds: alert.windowSeconds.toString(),
        alertLevel: alert.alertLevel,
        message: alert.message,
        cooldownSeconds: (alert.cooldownSeconds || 300).toString(),
      });
    }
  }

  /**
   * Check all registered alerts
   */
  async checkAlerts(): Promise<Alert[]> {
    const client = redis;
    const triggeredAlerts: Alert[] = [];

    // Get all alert configs
    const alertKeys = await client.keys(`${this.alertsPrefix}config:*`);

    for (const key of alertKeys) {
      const config = (await client.hgetall(key)) as unknown as AlertConfig;
      if (!config) continue;

      // Get current metric value
      const windowStats = await this.getMetricWindow(
        config.metric,
        config.windowSeconds,
      );
      const metricValue =
        config.metric.includes("rate") || config.metric.includes("latency")
          ? windowStats.avg
          : windowStats.sum;

      // Check threshold
      const triggered = this.evaluateThreshold(
        metricValue,
        config.threshold,
        config.operator,
      );

      if (triggered) {
        // Check cooldown
        const lastAlertKey = `${this.alertsPrefix}last:${config.name}`;
        const lastAlert = await client.get(lastAlertKey);
        const now = Date.now();

        if (
          lastAlert &&
          now - parseInt(lastAlert) < (config.cooldownSeconds || 300) * 1000
        ) {
          continue; // Still in cooldown
        }

        // Create alert
        const alert: Alert = {
          id: `alert:${config.name}:${now}`,
          name: config.name,
          level: config.alertLevel,
          message: config.message,
          metricValue,
          threshold: config.threshold,
          timestamp: new Date().toISOString(),
        };

        triggeredAlerts.push(alert);

        // Update last alert time
        await client.set(lastAlertKey, now.toString());
        await client.expire(lastAlertKey, config.cooldownSeconds || 300);

        // Send alert notification
        await this.sendAlertNotification(alert);

        this.logger.warn("Alert triggered", alert);
      }
    }

    return triggeredAlerts;
  }

  /**
   * Send alert notification
   */
  async sendAlertNotification(alert: Alert): Promise<void> {
    // Send to QStash for async processing
    await QStashService.publishJSON({
      url: `${process.env.APP_URL}/api/alerts/webhook`,
      body: {
        type: "alert",
        ...alert,
      },
    });

    // Also log to console
    const emoji = {
      [AlertLevel.INFO]: "ℹ️",
      [AlertLevel.WARNING]: "⚠️",
      [AlertLevel.ERROR]: "❌",
      [AlertLevel.CRITICAL]: "🚨",
    }[alert.level];

    console.log(
      `${emoji} [ALERT] ${alert.name}: ${alert.message} (value: ${alert.metricValue}, threshold: ${alert.threshold})`,
    );
  }

  /**
   * Manually send an alert
   */
  async sendAlert(
    message: string,
    level: AlertLevel = AlertLevel.INFO,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const alert: Alert = {
      id: `alert:manual:${Date.now()}`,
      name: "manual_alert",
      level,
      message,
      metricValue: 0,
      threshold: 0,
      timestamp: new Date().toISOString(),
    };

    await this.sendAlertNotification({ ...alert, ...metadata });
  }

  // ============================================================================
  // HEALTH CHECKS
  // ============================================================================

  /**
   * Register a health check
   */
  async registerHealthCheck(
    name: string,
    check: () => Promise<{
      status: "pass" | "warn" | "fail";
      message?: string;
      latency?: number;
    }>,
  ): Promise<void> {
    const client = redis;
    const key = `${this.metricsPrefix}health:${name}`;

    try {
      const startTime = Date.now();
      const result = await check();
      const latency = Date.now() - startTime;

      await client.hset(key, {
        status: result.status,
        message: result.message || "",
        latency: result.latency || latency,
        timestamp: new Date().toISOString(),
      });

      this.logger.debug("Health check registered", {
        name,
        status: result.status,
      });
    } catch (error) {
      await client.hset(key, {
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
        latency: "0",
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get overall health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    const client = redis;
    const healthKeys = await client.keys(`${this.metricsPrefix}health:*`);

    const checks: HealthCheck[] = [];
    let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";

    for (const key of healthKeys) {
      const data = await client.hgetall(key);
      const name = key.split(":")[2];

      checks.push({
        name,
        status: (data.status as "pass" | "warn" | "fail") || "fail",
        message: data.message,
        latency: parseFloat(data.latency || "0"),
        timestamp: data.timestamp || new Date().toISOString(),
      });

      // Update overall status
      if (data.status === "fail") {
        overallStatus = "unhealthy";
      } else if (data.status === "warn" && overallStatus !== "unhealthy") {
        overallStatus = "degraded";
      }
    }

    // Calculate uptime
    const uptime = process.uptime();

    return {
      status: overallStatus,
      checks,
      timestamp: new Date().toISOString(),
      uptime,
    };
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  private getMetricKey(name: string, labels?: Record<string, string>): string {
    let key = `${this.metricsPrefix}${name}`;
    if (labels) {
      const labelStr = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(":");
      key += `:${labelStr}`;
    }
    return key;
  }

  private evaluateThreshold(
    value: number,
    threshold: number,
    operator: string,
  ): boolean {
    switch (operator) {
      case ">":
        return value > threshold;
      case ">=":
        return value >= threshold;
      case "<":
        return value < threshold;
      case "<=":
        return value <= threshold;
      case "==":
        return value === threshold;
      default:
        return false;
    }
  }

  private startAlertMonitoring(): void {
    // Check alerts every minute
    setInterval(async () => {
      try {
        await this.checkAlerts();
      } catch (error) {
        this.logger.error("Alert monitoring failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 60000);

    this.logger.info("Alert monitoring started");
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const MonitoringService = new MonitoringServiceClass();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export async function trackMetric(
  name: string,
  value?: number,
  labels?: Record<string, string>,
) {
  if (value !== undefined) {
    return MonitoringService.setGauge(name, value, labels);
  }
  return MonitoringService.incrementMetric(name, 1, labels);
}

export async function trackLatency(
  name: string,
  latencyMs: number,
  labels?: Record<string, string>,
) {
  return MonitoringService.trackLatency(name, latencyMs, labels);
}

export async function trackError(endpoint: string, error: string) {
  await MonitoringService.incrementMetric("errors_total", 1, {
    endpoint,
    error,
  });
  await MonitoringService.trackLatency("error_latency", Date.now());
}

export async function getHealth() {
  return MonitoringService.getHealthStatus();
}
