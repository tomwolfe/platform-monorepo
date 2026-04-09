/**
 * SagaDebugger Component
 *
 * Visualizes saga steps as a vertical timeline for debugging cross-service saga failures.
 * Fetches data from `/api/debug/traces/[traceId]` (Intention Engine) and displays:
 * - Green Check: Completed Step
 * - Yellow Spinner: In Progress
 * - Red X: Failed Step (with error message tooltip)
 * - Gray Dot: Pending/Skipped
 *
 * Usage:
 * ```tsx
 * <SagaDebugger traceId="abc-123" />
 * ```
 *
 * @see Phase 1.2: Saga Debugger UI Component
 */

"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  Circle,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ============================================================================
// TYPES
// ============================================================================

interface WaterfallEntry {
  id: string;
  stepId?: string;
  phase: string;
  event: string;
  startTime: number;
  duration: number;
  status: "pending" | "success" | "failed" | "error" | "complete";
  error?: string;
  hasInput: boolean;
  hasOutput: boolean;
}

interface TraceMetrics {
  totalSteps: number;
  successfulSteps: number;
  failedSteps: number;
  totalLatencyMs: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  stepDetails: Record<
    string,
    {
      startTime: number;
      endTime: number;
      latencyMs: number;
      status: "pending" | "success" | "failed" | "error";
      error?: string;
    }
  >;
}

interface TraceData {
  trace_id: string;
  execution_id: string;
  started_at: string;
  ended_at?: string;
  status: string;
  entries: any[];
  waterfall: WaterfallEntry[];
  metrics: TraceMetrics;
  _enriched: boolean;
}

interface SagaDebuggerProps {
  /** Trace ID to visualize */
  traceId: string;
  /** Custom class name */
  className?: string;
  /** Auto-refresh interval in ms (0 = disabled) */
  refreshInterval?: number;
  /** Callback when trace data loads */
  onLoad?: (trace: TraceData) => void;
  /** Compact mode for embedding in dropdowns */
  compact?: boolean;
}

// ============================================================================
// SAGA DEBUGGER COMPONENT
// ============================================================================

export const SagaDebugger: React.FC<SagaDebuggerProps> = ({
  traceId,
  className = "",
  refreshInterval = 0,
  onLoad,
  compact = false,
}) => {
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const fetchTrace = useCallback(async () => {
    if (!traceId) return;

    try {
      setLoading((prev) => (trace ? false : prev)); // Don't show loading spinner on refresh
      const response = await fetch(`/api/debug/traces/${traceId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      setTrace(data);
      setError(null);
      onLoad?.(data);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch trace";
      setError(errorMessage);
      console.error("[SagaDebugger] Failed to fetch trace:", err);
    } finally {
      setLoading(false);
    }
  }, [traceId, onLoad]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  useEffect(() => {
    if (refreshInterval <= 0 || !trace) return;

    const isActive = trace.status === "in_progress";
    if (!isActive) return;

    const interval = setInterval(fetchTrace, refreshInterval);
    return () => clearInterval(interval);
  }, [trace, refreshInterval, fetchTrace]);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  if (loading && !trace) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <Loader2 size={24} className="animate-spin text-emerald-500" />
        <span className="ml-2 text-sm text-gray-400">Loading trace...</span>
      </div>
    );
  }

  if (error && !trace) {
    return (
      <div
        className={`p-4 bg-red-500/10 border border-red-500/30 rounded-lg ${className}`}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-200">
              Failed to load trace
            </p>
            <p className="text-xs text-red-300/80 mt-1">{error}</p>
            <button
              onClick={fetchTrace}
              className="mt-2 text-xs text-red-300 hover:text-red-200 underline"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!trace) {
    return null;
  }

  const { waterfall, metrics, status, started_at, ended_at, total_latency_ms } =
    trace;

  // Group waterfall entries by step
  const steps = groupWaterfallByStep(waterfall);

  if (compact) {
    return (
      <div className={`space-y-1 max-h-64 overflow-y-auto ${className}`}>
        {steps.map((step, index) => (
          <CompactStepEntry
            key={step.id}
            step={step}
            index={index}
            isLast={index === steps.length - 1}
          />
        ))}
      </div>
    );
  }

  const totalDuration = total_latency_ms || metrics?.totalLatencyMs || 0;
  const durationSeconds = (totalDuration / 1000).toFixed(1);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Header */}
      <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <div>
              <p className="text-sm font-semibold text-white">
                Saga Execution Trace
              </p>
              <p className="text-xs text-gray-400 font-mono">
                {traceId.slice(0, 12)}...
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">
              Status:{" "}
              <span className="text-white capitalize">
                {status.replace("_", " ")}
              </span>
            </p>
            <p className="text-xs text-gray-400">
              Duration: <span className="text-white">{durationSeconds}s</span>
            </p>
          </div>
        </div>

        {/* Metrics Bar */}
        {metrics && (
          <div className="flex gap-3 text-xs text-gray-400">
            <span>
              Steps:{" "}
              <span className="text-white">
                {metrics.successfulSteps}/{metrics.totalSteps}
              </span>
            </span>
            <span>
              Failed:{" "}
              <span
                className={
                  metrics.failedSteps > 0 ? "text-red-400" : "text-white"
                }
              >
                {metrics.failedSteps}
              </span>
            </span>
            {metrics.tokenUsage.totalTokens > 0 && (
              <span>
                Tokens:{" "}
                <span className="text-white">
                  {(metrics.tokenUsage.totalTokens / 1000).toFixed(1)}k
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="relative space-y-0">
        {steps.map((step, index) => (
          <StepTimelineEntry
            key={step.id}
            step={step}
            index={index}
            isLast={index === steps.length - 1}
            isExpanded={expandedSteps.has(step.id)}
            onToggle={() => toggleStep(step.id)}
          />
        ))}
      </div>

      {/* Footer */}
      {ended_at && (
        <div className="text-xs text-gray-500 text-center pt-2 border-t border-gray-800">
          Completed: {new Date(ended_at).toLocaleString()}
        </div>
      )}

      {/* Refresh indicator */}
      {refreshInterval > 0 && status === "in_progress" && (
        <div className="flex items-center justify-center gap-1 text-xs text-gray-500">
          <Loader2 size={10} className="animate-spin" />
          <span>Auto-refreshing...</span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// STEP TIMELINE ENTRY
// ============================================================================

interface StepTimelineEntryProps {
  step: StepGroup;
  index: number;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

const StepTimelineEntry: React.FC<StepTimelineEntryProps> = ({
  step,
  index,
  isLast,
  isExpanded,
  onToggle,
}) => {
  const hasError = step.status === "failed" || step.status === "error";
  const durationMs = step.duration || 0;
  const durationDisplay =
    durationMs > 1000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${durationMs}ms`;

  return (
    <div className="relative">
      {/* Vertical connector line */}
      {!isLast && (
        <div className="absolute left-3 top-6 bottom-0 w-px bg-gray-700" />
      )}

      {/* Step row */}
      <div className="flex items-start gap-3 py-2">
        {/* Icon */}
        <div className="relative z-10 flex-shrink-0">
          <StatusIcon status={step.status} size={20} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <button
            onClick={onToggle}
            className="w-full text-left flex items-center justify-between gap-2 group"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {step.displayName}
              </p>
              {step.error && (
                <p
                  className="text-xs text-red-400 mt-0.5 truncate"
                  title={step.error}
                >
                  {step.error}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-gray-500">{durationDisplay}</span>
              {step.subEntries.length > 1 &&
                (isExpanded ? (
                  <ChevronUp
                    size={14}
                    className="text-gray-500 group-hover:text-gray-300"
                  />
                ) : (
                  <ChevronDown
                    size={14}
                    className="text-gray-500 group-hover:text-gray-300"
                  />
                ))}
            </div>
          </button>

          {/* Expanded details */}
          {isExpanded && step.subEntries.length > 1 && (
            <div className="mt-2 ml-2 space-y-1 pl-3 border-l border-gray-700">
              {step.subEntries.map((entry, i) => (
                <div
                  key={i}
                  className="text-xs text-gray-400 flex items-center gap-2"
                >
                  <Circle size={8} className="text-gray-600" />
                  <span className="capitalize">
                    {entry.event.replace("_", " ")}
                  </span>
                  <span className="text-gray-600">•</span>
                  <span>
                    {entry.duration > 0 ? `${entry.duration}ms` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// COMPACT STEP ENTRY (for dropdown mode)
// ============================================================================

interface CompactStepEntryProps {
  step: StepGroup;
  index: number;
  isLast: boolean;
}

const CompactStepEntry: React.FC<CompactStepEntryProps> = ({
  step,
  isLast,
}) => {
  return (
    <div className="relative flex items-center gap-2 py-1">
      {!isLast && (
        <div className="absolute left-2 top-4 bottom-0 w-px bg-gray-700" />
      )}
      <StatusIcon status={step.status} size={16} />
      <span className="text-xs text-gray-300 truncate">{step.displayName}</span>
      {step.error && (
        <span
          className="text-xs text-red-400 ml-auto truncate max-w-[120px]"
          title={step.error}
        >
          {step.error.slice(0, 30)}...
        </span>
      )}
    </div>
  );
};

// ============================================================================
// STATUS ICON
// ============================================================================

interface StatusIconProps {
  status: string;
  size?: number;
}

const StatusIcon: React.FC<StatusIconProps> = ({ status, size = 16 }) => {
  switch (status) {
    case "success":
    case "completed":
    case "complete":
      return (
        <CheckCircle2 size={size} className="text-green-500 flex-shrink-0" />
      );
    case "pending":
    case "in_progress":
      return (
        <Loader2
          size={size}
          className="text-yellow-500 animate-spin flex-shrink-0"
        />
      );
    case "failed":
    case "error":
      return <XCircle size={size} className="text-red-500 flex-shrink-0" />;
    case "skipped":
      return <Circle size={size} className="text-gray-600 flex-shrink-0" />;
    default:
      return <Circle size={size} className="text-gray-500 flex-shrink-0" />;
  }
};

// ============================================================================
// HELPERS
// ============================================================================

interface StepGroup {
  id: string;
  stepId?: string;
  displayName: string;
  status: string;
  error?: string;
  duration: number;
  subEntries: WaterfallEntry[];
}

function groupWaterfallByStep(entries: WaterfallEntry[]): StepGroup[] {
  const stepMap = new Map<string, StepGroup>();

  for (const entry of entries) {
    const key = entry.stepId || entry.id;

    if (!stepMap.has(key)) {
      stepMap.set(key, {
        id: entry.stepId || entry.id,
        stepId: entry.stepId,
        displayName: formatStepName(entry),
        status: entry.status,
        error: entry.error,
        duration: entry.duration || 0,
        subEntries: [entry],
      });
    } else {
      const step = stepMap.get(key)!;
      step.subEntries.push(entry);

      // Update status to most recent/relevant
      if (entry.status === "failed" || entry.status === "error") {
        step.status = entry.status;
        step.error = entry.error || step.error;
      } else if (entry.status === "success" && step.status === "pending") {
        step.status = entry.status;
      }

      // Accumulate duration
      if (entry.duration > 0) {
        step.duration = Math.max(step.duration, entry.duration);
      }
    }
  }

  return Array.from(stepMap.values());
}

function formatStepName(entry: WaterfallEntry): string {
  // Format phase + event into human-readable name
  const phase = entry.phase.charAt(0).toUpperCase() + entry.phase.slice(1);
  const event = entry.event.replace(/_/g, " ");

  if (entry.stepId) {
    return `${phase}: Step ${entry.stepId.slice(0, 8)}`;
  }

  return `${phase}: ${event}`;
}

export default SagaDebugger;
