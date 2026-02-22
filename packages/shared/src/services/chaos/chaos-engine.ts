/**
 * Automated Chaos Engineering Framework
 *
 * Automatically injects failures into the system to test resilience.
 * Integrates with existing chaos tests and provides automated experiment runs.
 *
 * Failure Types:
 * 1. Latency Injection (API delays)
 * 2. Error Injection (random failures)
 * 3. Resource Exhaustion (memory, CPU limits)
 * 4. Network Partitions (service isolation)
 * 5. Dependency Failures (external service mock failures)
 * 6. State Corruption (Redis/DB corruption simulation)
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// CHAOS EXPERIMENT CONFIGURATION
// ============================================================================

export interface ChaosExperimentConfig {
  /** Experiment name */
  name: string;
  /** Experiment description */
  description?: string;
  /** Target service/component */
  target: string;
  /** Failure type to inject */
  failureType: FailureType;
  /** Failure parameters */
  parameters: FailureParameters;
  /** Duration of experiment in ms */
  durationMs: number;
  /** Steady state hypotheses to verify */
  hypotheses: SteadyStateHypothesis[];
  /** Rollback actions if hypotheses fail */
  rollbackActions: RollbackAction[];
  /** Safety checks before starting */
  safetyChecks: SafetyCheck[];
}

export type FailureType =
  | 'LATENCY_INJECTION'
  | 'ERROR_INJECTION'
  | 'RESOURCE_EXHAUSTION'
  | 'NETWORK_PARTITION'
  | 'DEPENDENCY_FAILURE'
  | 'STATE_CORRUPTION'
  | 'CIRCUIT_BREAKER_TRIP';

export interface FailureParameters {
  // Latency injection
  latencyMs?: number;
  latencyJitterMs?: number;
  latencyProbability?: number;

  // Error injection
  errorCode?: string;
  errorMessage?: string;
  errorRate?: number; // 0-1

  // Resource exhaustion
  memoryLimitMb?: number;
  cpuLimitPercent?: number;

  // Network partition
  isolatedServices?: string[];

  // Dependency failure
  dependencyName?: string;
  failureMode?: 'timeout' | 'error' | 'empty_response';

  // State corruption
  corruptionPattern?: 'random_bits' | 'truncate' | 'duplicate';
}

export interface SteadyStateHypothesis {
  /** Hypothesis name */
  name: string;
  /** Metric to monitor */
  metric: string;
  /** Expected condition */
  condition: 'equals' | 'less_than' | 'greater_than' | 'within_range';
  /** Expected value or range */
  expectedValue: number | [number, number];
  /** Tolerance (for equals) */
  tolerance?: number;
}

export interface RollbackAction {
  /** Action type */
  type: 'stop_injection' | 'restart_service' | 'restore_state' | 'scale_up';
  /** Target service */
  target?: string;
  /** Action parameters */
  parameters?: Record<string, unknown>;
}

export interface SafetyCheck {
  /** Check name */
  name: string;
  /** Check type */
  type: 'service_healthy' | 'traffic_low' | 'business_hours' | 'manual_approval';
  /** Check parameters */
  parameters?: Record<string, unknown>;
}

// ============================================================================
// CHAOS EXPERIMENT RESULT
// ============================================================================

export interface ChaosExperimentResult {
  /** Experiment ID */
  experimentId: string;
  /** Experiment name */
  name: string;
  /** Whether experiment completed successfully */
  success: boolean;
  /** Start time */
  startedAt: number;
  /** End time */
  endedAt: number;
  /** Duration in ms */
  durationMs: number;
  /** Hypothesis results */
  hypothesisResults: HypothesisResult[];
  /** Metrics collected during experiment */
  metrics: Record<string, MetricDataPoint[]>;
  /** Events during experiment */
  events: ChaosEvent[];
  /** Whether rollback was triggered */
  rollbackTriggered: boolean;
  /** Rollback results */
  rollbackResults?: RollbackResult[];
  /** Lessons learned */
  lessonsLearned: string[];
}

export interface HypothesisResult {
  hypothesis: SteadyStateHypothesis;
  passed: boolean;
  actualValue: number;
  message: string;
}

export interface MetricDataPoint {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

export interface ChaosEvent {
  timestamp: number;
  type: 'injection_start' | 'injection_stop' | 'hypothesis_check' | 'rollback' | 'error';
  message: string;
  data?: unknown;
}

export interface RollbackResult {
  action: RollbackAction;
  success: boolean;
  message: string;
}

// ============================================================================
// CHAOS ENGINE
// ============================================================================

export class ChaosEngine extends EventEmitter {
  private activeExperiments: Map<string, ChaosExperimentConfig> = new Map();
  private experimentResults: Map<string, ChaosExperimentResult> = new Map();
  private failureInjections: Map<string, FailureInjection> = new Map();
  private config: {
    maxConcurrentExperiments: number;
    defaultDurationMs: number;
    enableMetrics: boolean;
  };

  constructor(config?: {
    maxConcurrentExperiments?: number;
    defaultDurationMs?: number;
    enableMetrics?: boolean;
  }) {
    super();
    this.config = {
      maxConcurrentExperiments: 3,
      defaultDurationMs: 60000,
      enableMetrics: true,
      ...config,
    };
  }

  /**
   * Start a chaos experiment
   */
  async startExperiment(config: ChaosExperimentConfig): Promise<ChaosExperimentResult> {
    const experimentId = this.generateExperimentId();
    
    // Check concurrent experiment limit
    if (this.activeExperiments.size >= this.config.maxConcurrentExperiments) {
      throw new Error(`Maximum concurrent experiments (${this.config.maxConcurrentExperiments}) reached`);
    }

    // Run safety checks
    const safetyCheckResults = await this.runSafetyChecks(config.safetyChecks);
    if (!safetyCheckResults.allPassed) {
      throw new Error(`Safety checks failed: ${safetyCheckResults.failedChecks.map(c => c.name).join(', ')}`);
    }

    // Create experiment result tracker
    const result: ChaosExperimentResult = {
      experimentId,
      name: config.name,
      success: true,
      startedAt: Date.now(),
      endedAt: 0,
      durationMs: 0,
      hypothesisResults: [],
      metrics: {},
      events: [],
      rollbackTriggered: false,
      lessonsLearned: [],
    };

    // Add start event
    result.events.push({
      timestamp: Date.now(),
      type: 'injection_start',
      message: `Starting experiment: ${config.name}`,
      data: { target: config.target, failureType: config.failureType },
    });

    // Store active experiment
    this.activeExperiments.set(experimentId, config);
    this.experimentResults.set(experimentId, result);

    this.emit('experiment_start', { experimentId, config });

    try {
      // Start failure injection
      const injection = await this.startFailureInjection(config);
      this.failureInjections.set(experimentId, injection);

      // Monitor hypotheses during experiment
      const monitorInterval = setInterval(async () => {
        const hypothesisResults = await this.checkHypotheses(config.hypotheses);
        result.hypothesisResults = hypothesisResults;

        const allPassed = hypothesisResults.every(h => h.passed);
        if (!allPassed) {
          // Trigger rollback
          await this.triggerRollback(config, result);
          result.success = false;
          clearInterval(monitorInterval);
        }

        result.events.push({
          timestamp: Date.now(),
          type: 'hypothesis_check',
          message: `Hypothesis check: ${allPassed ? 'PASSED' : 'FAILED'}`,
          data: { results: hypothesisResults },
        });
      }, 5000); // Check every 5 seconds

      // Wait for experiment duration
      await this.sleep(config.durationMs || this.config.defaultDurationMs);

      // Stop monitoring
      clearInterval(monitorInterval);

      // Stop failure injection
      await this.stopFailureInjection(injection);
      this.failureInjections.delete(experimentId);

      // Final hypothesis check
      const finalHypothesisResults = await this.checkHypotheses(config.hypotheses);
      result.hypothesisResults = finalHypothesisResults;

      // Add stop event
      result.events.push({
        timestamp: Date.now(),
        type: 'injection_stop',
        message: `Stopping experiment: ${config.name}`,
      });

      // Calculate results
      result.endedAt = Date.now();
      result.durationMs = result.endedAt - result.startedAt;
      result.success = finalHypothesisResults.every(h => h.passed);

      // Generate lessons learned
      result.lessonsLearned = this.generateLessonsLearned(config, result);

      // Store result
      this.activeExperiments.delete(experimentId);
      this.experimentResults.set(experimentId, result);

      this.emit('experiment_complete', { experimentId, result });

      return result;
    } catch (error) {
      // Handle experiment error
      result.events.push({
        timestamp: Date.now(),
        type: 'error',
        message: `Experiment error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });

      result.success = false;
      result.endedAt = Date.now();
      result.durationMs = result.endedAt - result.startedAt;

      // Emergency rollback
      await this.emergencyRollback(config);

      this.activeExperiments.delete(experimentId);
      this.experimentResults.set(experimentId, result);

      this.emit('experiment_error', { experimentId, error });

      throw error;
    }
  }

  /**
   * Start failure injection
   */
  private async startFailureInjection(config: ChaosExperimentConfig): Promise<FailureInjection> {
    const injection: FailureInjection = {
      id: this.generateExperimentId(),
      type: config.failureType,
      target: config.target,
      startTime: Date.now(),
      active: true,
    };

    // Apply failure based on type
    switch (config.failureType) {
      case 'LATENCY_INJECTION':
        await this.injectLatency(config.target, config.parameters);
        break;
      case 'ERROR_INJECTION':
        await this.injectErrors(config.target, config.parameters);
        break;
      case 'RESOURCE_EXHAUSTION':
        await this.exhaustResources(config.target, config.parameters);
        break;
      case 'NETWORK_PARTITION':
        await this.createNetworkPartition(config.parameters);
        break;
      case 'DEPENDENCY_FAILURE':
        await this.failDependency(config.parameters);
        break;
      case 'STATE_CORRUPTION':
        await this.corruptState(config.target, config.parameters);
        break;
      case 'CIRCUIT_BREAKER_TRIP':
        await this.tripCircuitBreaker(config.target);
        break;
    }

    this.emit('injection_start', injection);
    return injection;
  }

  /**
   * Stop failure injection
   */
  private async stopFailureInjection(injection: FailureInjection): Promise<void> {
    injection.active = false;
    injection.endTime = Date.now();

    // Remove failure injection
    this.emit('injection_stop', injection);
  }

  /**
   * Check hypotheses
   */
  private async checkHypotheses(hypotheses: SteadyStateHypothesis[]): Promise<HypothesisResult[]> {
    const results: HypothesisResult[] = [];

    for (const hypothesis of hypotheses) {
      const actualValue = await this.measureMetric(hypothesis.metric);
      
      let passed = false;
      let message = '';

      switch (hypothesis.condition) {
        case 'equals':
          passed = Math.abs(actualValue - (hypothesis.expectedValue as number)) <= (hypothesis.tolerance || 0);
          message = `Expected ${hypothesis.expectedValue} ± ${hypothesis.tolerance || 0}, got ${actualValue}`;
          break;
        case 'less_than':
          passed = actualValue < (hypothesis.expectedValue as number);
          message = `Expected < ${hypothesis.expectedValue}, got ${actualValue}`;
          break;
        case 'greater_than':
          passed = actualValue > (hypothesis.expectedValue as number);
          message = `Expected > ${hypothesis.expectedValue}, got ${actualValue}`;
          break;
        case 'within_range':
          const [min, max] = hypothesis.expectedValue as [number, number];
          passed = actualValue >= min && actualValue <= max;
          message = `Expected [${min}, ${max}], got ${actualValue}`;
          break;
      }

      results.push({
        hypothesis,
        passed,
        actualValue,
        message,
      });
    }

    return results;
  }

  /**
   * Run safety checks
   */
  private async runSafetyChecks(checks: SafetyCheck[]): Promise<{
    allPassed: boolean;
    failedChecks: Array<{ name: string; reason: string }>;
  }> {
    const failedChecks: Array<{ name: string; reason: string }> = [];

    for (const check of checks) {
      let passed = false;
      let reason = '';

      switch (check.type) {
        case 'service_healthy':
          passed = await this.isServiceHealthy(check.parameters?.target as string);
          reason = passed ? 'Service is healthy' : 'Service is unhealthy';
          break;
        case 'traffic_low':
          const traffic = await this.getCurrentTraffic();
          passed = traffic < (check.parameters?.maxTraffic as number || 1000);
          reason = passed ? 'Traffic is low' : 'Traffic is too high';
          break;
        case 'business_hours':
          const hour = new Date().getHours();
          passed = hour < 6 || hour > 22; // Only run outside business hours
          reason = passed ? 'Outside business hours' : 'During business hours';
          break;
        case 'manual_approval':
          // In production, this would wait for manual approval
          passed = true; // Auto-approve for testing
          reason = 'Auto-approved';
          break;
      }

      if (!passed) {
        failedChecks.push({ name: check.name, reason });
      }
    }

    return {
      allPassed: failedChecks.length === 0,
      failedChecks,
    };
  }

  /**
   * Trigger rollback
   */
  private async triggerRollback(
    config: ChaosExperimentConfig,
    result: ChaosExperimentResult
  ): Promise<void> {
    result.rollbackTriggered = true;
    const rollbackResults: RollbackResult[] = [];

    for (const action of config.rollbackActions) {
      try {
        await this.executeRollbackAction(action);
        rollbackResults.push({
          action,
          success: true,
          message: 'Rollback successful',
        });
      } catch (error) {
        rollbackResults.push({
          action,
          success: false,
          message: error instanceof Error ? error.message : 'Rollback failed',
        });
      }
    }

    result.rollbackResults = rollbackResults;

    result.events.push({
      timestamp: Date.now(),
      type: 'rollback',
      message: 'Rollback triggered due to hypothesis failure',
      data: { results: rollbackResults },
    });
  }

  /**
   * Emergency rollback
   */
  private async emergencyRollback(config: ChaosExperimentConfig): Promise<void> {
    // Stop all injections immediately
    for (const injection of this.failureInjections.values()) {
      await this.stopFailureInjection(injection);
    }

    // Execute emergency rollback actions
    for (const action of config.rollbackActions) {
      try {
        await this.executeRollbackAction(action);
      } catch (error) {
        console.error('[ChaosEngine] Emergency rollback failed:', error);
      }
    }
  }

  // ========================================================================
  // FAILURE INJECTION IMPLEMENTATIONS
  // ========================================================================

  private async injectLatency(target: string, params: FailureParameters): Promise<void> {
    // In production, this would inject latency into the target service
    console.log(`[ChaosEngine] Injecting ${params.latencyMs}ms latency into ${target}`);
  }

  private async injectErrors(target: string, params: FailureParameters): Promise<void> {
    console.log(`[ChaosEngine] Injecting ${params.errorCode} errors into ${target} at ${(params.errorRate || 0) * 100}% rate`);
  }

  private async exhaustResources(target: string, params: FailureParameters): Promise<void> {
    console.log(`[ChaosEngine] Exhausting resources on ${target}: memory=${params.memoryLimitMb}MB, cpu=${params.cpuLimitPercent}%`);
  }

  private async createNetworkPartition(params: FailureParameters): Promise<void> {
    console.log(`[ChaosEngine] Creating network partition, isolated services: ${params.isolatedServices?.join(', ')}`);
  }

  private async failDependency(params: FailureParameters): Promise<void> {
    console.log(`[ChaosEngine] Failing dependency ${params.dependencyName} with mode: ${params.failureMode}`);
  }

  private async corruptState(target: string, params: FailureParameters): Promise<void> {
    console.log(`[ChaosEngine] Corrupting state on ${target} with pattern: ${params.corruptionPattern}`);
  }

  private async tripCircuitBreaker(target: string): Promise<void> {
    console.log(`[ChaosEngine] Tripping circuit breaker for ${target}`);
  }

  private async executeRollbackAction(action: RollbackAction): Promise<void> {
    console.log(`[ChaosEngine] Executing rollback action: ${action.type} on ${action.target}`);
  }

  private async measureMetric(metric: string): Promise<number> {
    // In production, this would query actual metrics
    return Math.random() * 100;
  }

  private async isServiceHealthy(target: string): Promise<boolean> {
    return true;
  }

  private async getCurrentTraffic(): Promise<number> {
    return Math.random() * 1000;
  }

  private generateLessonsLearned(config: ChaosExperimentConfig, result: ChaosExperimentResult): string[] {
    const lessons: string[] = [];

    if (result.success) {
      lessons.push(`System handled ${config.failureType} injection successfully`);
    } else {
      lessons.push(`System failed to handle ${config.failureType} injection`);
      const failedHypotheses = result.hypothesisResults.filter(h => !h.passed);
      for (const h of failedHypotheses) {
        lessons.push(`Hypothesis "${h.hypothesis.name}" failed: ${h.message}`);
      }
    }

    if (result.rollbackTriggered) {
      lessons.push('Rollback was triggered - verify rollback procedures are effective');
    }

    return lessons;
  }

  private generateExperimentId(): string {
    return `chaos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Get experiment result
   */
  getExperimentResult(experimentId: string): ChaosExperimentResult | null {
    return this.experimentResults.get(experimentId) || null;
  }

  /**
   * Get all experiment results
   */
  getAllResults(): ChaosExperimentResult[] {
    return Array.from(this.experimentResults.values());
  }

  /**
   * Get active experiments
   */
  getActiveExperiments(): string[] {
    return Array.from(this.activeExperiments.keys());
  }

  /**
   * Stop all experiments
   */
  async stopAllExperiments(): Promise<void> {
    for (const [experimentId, injection] of this.failureInjections) {
      await this.stopFailureInjection(injection);
    }
  }
}

interface FailureInjection {
  id: string;
  type: FailureType;
  target: string;
  startTime: number;
  endTime?: number;
  active: boolean;
}

// ============================================================================
// FACTORY
// ============================================================================

export function createChaosEngine(config?: ConstructorParameters<typeof ChaosEngine>[0]): ChaosEngine {
  return new ChaosEngine(config);
}
