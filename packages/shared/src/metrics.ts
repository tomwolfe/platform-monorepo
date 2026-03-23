/**
 * Metrics & Monitoring
 *
 * Provides Prometheus-compatible metrics for monitoring and alerting.
 * Includes request metrics, database metrics, cache metrics, and business metrics.
 *
 * Usage:
 * ```typescript
 * import { metrics, observeRequest, Counter, Histogram } from '@repo/shared';
 *
 * // Increment counter
 * metrics.errors.inc({ type: 'database' });
 *
 * // Observe request duration
 * const end = observeRequest('POST', '/api/v1/reserve');
 * // ... handler logic
 * end();
 *
 * // Get Prometheus metrics
 * const metricsText = await metrics.getMetrics();
 * ```
 *
 * @see Phase 3.1: Monitoring & Alerting
 */

// ============================================================================
// TYPES
// ============================================================================

export interface MetricLabels {
  [key: string]: string | number;
}

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: string[];
}

export interface Collector {
  collect(): Promise<MetricFamily[]>;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  metrics: Metric[];
}

export interface Metric {
  labels?: MetricLabels;
  value?: number;
  buckets?: Bucket[];
  sum?: number;
  count?: number;
}

export interface Bucket {
  le: number;
  count: number;
}

// ============================================================================
// METRIC TYPES
// ============================================================================

/**
 * Counter metric - only increases
 */
export class Counter {
  private values: Map<string, number> = new Map();
  private labelNames: string[];

  constructor(private name: string, private help: string, labelNames: string[] = []) {
    this.labelNames = labelNames;
  }

  inc(labels: MetricLabels = {}, value: number = 1): void {
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  private getKey(labels: MetricLabels): string {
    if (Object.keys(labels).length === 0) {
      return '';
    }
    return this.labelNames.map(name => `${name}=${labels[name]}`).join(':');
  }

  get(): MetricFamily {
    const metrics: Metric[] = [];
    
    if (this.values.size === 0) {
      metrics.push({ value: 0 });
    } else {
      for (const [key, value] of this.values.entries()) {
        const labels: MetricLabels = {};
        if (key) {
          key.split(':').forEach((part, i) => {
            const [labelName, labelValue] = part.split('=');
            labels[labelName] = labelValue;
          });
        }
        metrics.push({ labels, value });
      }
    }

    return {
      name: this.name,
      help: this.help,
      type: 'counter',
      metrics,
    };
  }
}

/**
 * Gauge metric - can increase or decrease
 */
export class Gauge {
  private values: Map<string, number> = new Map();
  private labelNames: string[];

  constructor(private name: string, private help: string, labelNames: string[] = []) {
    this.labelNames = labelNames;
  }

  set(value: number, labels: MetricLabels = {}): void {
    const key = this.getKey(labels);
    this.values.set(key, value);
  }

  inc(labels: MetricLabels = {}, value: number = 1): void {
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels: MetricLabels = {}, value: number = 1): void {
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  private getKey(labels: MetricLabels): string {
    if (Object.keys(labels).length === 0) {
      return '';
    }
    return this.labelNames.map(name => `${name}=${labels[name]}`).join(':');
  }

  get(): MetricFamily {
    const metrics: Metric[] = [];
    
    if (this.values.size === 0) {
      metrics.push({ value: 0 });
    } else {
      for (const [key, value] of this.values.entries()) {
        const labels: MetricLabels = {};
        if (key) {
          key.split(':').forEach((part, i) => {
            const [labelName, labelValue] = part.split('=');
            labels[labelName] = labelValue;
          });
        }
        metrics.push({ labels, value });
      }
    }

    return {
      name: this.name,
      help: this.help,
      type: 'gauge',
      metrics,
    };
  }
}

/**
 * Histogram metric - tracks distribution of values
 */
export class Histogram {
  private buckets: number[];
  private bucketValues: Map<string, Map<number, number>> = new Map();
  private sums: Map<string, number> = new Map();
  private counts: Map<string, number> = new Map();
  private labelNames: string[];

  constructor(
    private name: string,
    private help: string,
    options: { buckets?: number[]; labelNames?: string[] } = {}
  ) {
    this.buckets = options.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.labelNames = options.labelNames || [];
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = this.getKey(labels);
    
    // Update sum and count
    this.sums.set(key, (this.sums.get(key) || 0) + value);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);

    // Update buckets
    if (!this.bucketValues.has(key)) {
      this.bucketValues.set(key, new Map());
    }
    const bucketMap = this.bucketValues.get(key)!;
    
    for (const bucket of this.buckets) {
      const current = bucketMap.get(bucket) || 0;
      if (value <= bucket) {
        bucketMap.set(bucket, current + 1);
      }
    }
  }

  private getKey(labels: MetricLabels): string {
    if (Object.keys(labels).length === 0) {
      return '';
    }
    return this.labelNames.map(name => `${name}=${labels[name]}`).join(':');
  }

  get(): MetricFamily[] {
    const families: MetricFamily[] = [];
    const keys = new Set([...this.bucketValues.keys(), ...this.sums.keys()]);

    // Bucket metrics
    const bucketMetrics: Metric[] = [];
    const sumMetrics: Metric[] = [];
    const countMetrics: Metric[] = [];

    for (const key of keys) {
      const labels: MetricLabels = {};
      if (key) {
        key.split(':').forEach((part, i) => {
          const [labelName, labelValue] = part.split('=');
          labels[labelName] = labelValue;
        });
      }

      // Buckets
      const bucketMap = this.bucketValues.get(key) || new Map();
      for (const bucket of this.buckets) {
        bucketMetrics.push({
          labels: { ...labels, le: bucket },
          value: bucketMap.get(bucket) || 0,
        });
      }
      bucketMetrics.push({ labels: { ...labels, le: '+Inf' }, value: this.counts.get(key) || 0 });

      // Sum
      sumMetrics.push({ labels, value: this.sums.get(key) || 0 });

      // Count
      countMetrics.push({ labels, value: this.counts.get(key) || 0 });
    }

    families.push({
      name: `${this.name}_bucket`,
      help: this.help,
      type: 'histogram',
      metrics: bucketMetrics,
    });

    families.push({
      name: `${this.name}_sum`,
      help: `${this.help} - sum`,
      type: 'histogram',
      metrics: sumMetrics,
    });

    families.push({
      name: `${this.name}_count`,
      help: `${this.help} - count`,
      type: 'histogram',
      metrics: countMetrics,
    });

    return families;
  }
}

// ============================================================================
// METRICS REGISTRY
// ============================================================================

export class MetricsRegistry {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private collectors: Collector[] = [];

  // Pre-defined metrics
  public readonly httpRequestsTotal: Counter;
  public readonly httpRequestsDuration: Histogram;
  public readonly httpRequestsInFlight: Gauge;
  public readonly errorsTotal: Counter;
  public readonly databaseQueriesTotal: Counter;
  public readonly databaseQueriesDuration: Histogram;
  public readonly cacheHitsTotal: Counter;
  public readonly cacheMissesTotal: Counter;
  public readonly cacheSize: Gauge;
  public readonly activeConnections: Gauge;
  public readonly memoryUsage: Gauge;
  public readonly eventBusEventsTotal: Counter;
  public readonly eventBusEventsDuration: Histogram;

  constructor() {
    // HTTP Metrics
    this.httpRequestsTotal = this.createCounter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status'],
    });

    this.httpRequestsDuration = this.createHistogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    this.httpRequestsInFlight = this.createGauge({
      name: 'http_requests_in_flight',
      help: 'Number of HTTP requests currently being processed',
      labelNames: ['method'],
    });

    // Error Metrics
    this.errorsTotal = this.createCounter({
      name: 'errors_total',
      help: 'Total number of errors',
      labelNames: ['type', 'code'],
    });

    // Database Metrics
    this.databaseQueriesTotal = this.createCounter({
      name: 'database_queries_total',
      help: 'Total number of database queries',
      labelNames: ['table', 'operation'],
    });

    this.databaseQueriesDuration = this.createHistogram({
      name: 'database_query_duration_seconds',
      help: 'Database query duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    });

    // Cache Metrics
    this.cacheHitsTotal = this.createCounter({
      name: 'cache_hits_total',
      help: 'Total number of cache hits',
      labelNames: ['cache'],
    });

    this.cacheMissesTotal = this.createCounter({
      name: 'cache_misses_total',
      help: 'Total number of cache misses',
      labelNames: ['cache'],
    });

    this.cacheSize = this.createGauge({
      name: 'cache_size',
      help: 'Current cache size',
      labelNames: ['cache'],
    });

    // Connection Metrics
    this.activeConnections = this.createGauge({
      name: 'active_connections',
      help: 'Number of active connections',
      labelNames: ['type'],
    });

    // Memory Metrics
    this.memoryUsage = this.createGauge({
      name: 'memory_usage_bytes',
      help: 'Current memory usage in bytes',
      labelNames: ['type'],
    });

    // Event Bus Metrics
    this.eventBusEventsTotal = this.createCounter({
      name: 'event_bus_events_total',
      help: 'Total number of events processed',
      labelNames: ['event_type'],
    });

    this.eventBusEventsDuration = this.createHistogram({
      name: 'event_bus_event_duration_seconds',
      help: 'Event processing duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
    });
  }

  createCounter(options: MetricOptions): Counter {
    const counter = new Counter(options.name, options.help, options.labelNames);
    this.counters.set(options.name, counter);
    return counter;
  }

  createGauge(options: MetricOptions): Gauge {
    const gauge = new Gauge(options.name, options.help, options.labelNames);
    this.gauges.set(options.name, gauge);
    return gauge;
  }

  createHistogram(options: MetricOptions & { buckets?: number[] }): Histogram {
    const histogram = new Histogram(options.name, options.help, options);
    this.histograms.set(options.name, histogram);
    return histogram;
  }

  addCollector(collector: Collector): void {
    this.collectors.push(collector);
  }

  async getMetrics(): Promise<string> {
    const lines: string[] = [];

    // Collect from counters
    for (const counter of this.counters.values()) {
      const family = counter.get();
      lines.push(this.formatMetric(family));
    }

    // Collect from gauges
    for (const gauge of this.gauges.values()) {
      const family = gauge.get();
      lines.push(this.formatMetric(family));
    }

    // Collect from histograms
    for (const histogram of this.histograms.values()) {
      const families = histogram.get();
      for (const family of families) {
        lines.push(this.formatMetric(family));
      }
    }

    // Collect from custom collectors
    for (const collector of this.collectors) {
      const families = await collector.collect();
      for (const family of families) {
        lines.push(this.formatMetric(family));
      }
    }

    // Add system metrics
    lines.push(this.getSystemMetrics());

    return lines.join('\n') + '\n';
  }

  private formatMetric(family: MetricFamily): string {
    const lines: string[] = [];
    
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);

    for (const metric of family.metrics) {
      let labelsStr = '';
      if (metric.labels && Object.keys(metric.labels).length > 0) {
        const labelParts = Object.entries(metric.labels)
          .map(([k, v]) => `${k}="${v}"`);
        labelsStr = `{${labelParts.join(',')}}`;
      }

      if (family.type === 'histogram' && family.name.endsWith('_bucket')) {
        lines.push(`${family.name}${labelsStr} ${metric.value || 0}`);
      } else if (family.type === 'histogram') {
        lines.push(`${family.name}${labelsStr} ${metric.value || 0}`);
      } else {
        lines.push(`${family.name}${labelsStr} ${metric.value || 0}`);
      }
    }

    return lines.join('\n');
  }

  private getSystemMetrics(): string {
    const lines: string[] = [];
    const memUsage = process.memoryUsage();

    lines.push('# HELP nodejs_memory_usage_bytes Node.js memory usage');
    lines.push('# TYPE nodejs_memory_usage_bytes gauge');
    lines.push(`nodejs_memory_usage_bytes{type="heap_used"} ${memUsage.heapUsed}`);
    lines.push(`nodejs_memory_usage_bytes{type="heap_total"} ${memUsage.heapTotal}`);
    lines.push(`nodejs_memory_usage_bytes{type="rss"} ${memUsage.rss}`);
    lines.push(`nodejs_memory_usage_bytes{type="external"} ${memUsage.external}`);

    lines.push('# HELP nodejs_uptime_seconds Node.js uptime in seconds');
    lines.push('# TYPE nodejs_uptime_seconds gauge');
    lines.push(`nodejs_uptime_seconds ${Math.floor(process.uptime())}`);

    return lines.join('\n');
  }

  // Update memory metrics periodically
  startMemoryTracking(intervalMs: number = 10000): void {
    setInterval(() => {
      const memUsage = process.memoryUsage();
      this.memoryUsage.set(memUsage.heapUsed, { type: 'heap_used' });
      this.memoryUsage.set(memUsage.heapTotal, { type: 'heap_total' });
      this.memoryUsage.set(memUsage.rss, { type: 'rss' });
    }, intervalMs);
  }
}

// ============================================================================
// REQUEST OBSERVER
// ============================================================================

/**
 * Observe HTTP request duration
 */
export function observeRequest(
  metrics: MetricsRegistry,
  method: string,
  path: string
): () => void {
  const start = Date.now() / 1000;
  metrics.httpRequestsInFlight.inc({ method });

  return () => {
    const duration = (Date.now() / 1000) - start;
    metrics.httpRequestsDuration.observe(duration, { method, path });
    metrics.httpRequestsInFlight.dec({ method });
  };
}

// ============================================================================
// SINGLETON
// ============================================================================

export const metrics = new MetricsRegistry();

// Start memory tracking
metrics.startMemoryTracking();

// ============================================================================
// EXPORTS
// ============================================================================

export {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  observeRequest,
  metrics,
  type MetricLabels,
  type MetricOptions,
  type Collector,
  type MetricFamily,
  type Metric,
  type Bucket,
};
