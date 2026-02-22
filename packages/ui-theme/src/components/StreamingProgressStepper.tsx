/**
 * Streaming Progress Stepper
 * 
 * Vercel Hobby Tier Optimization:
 * - Visualizes StreamingStatusUpdate events from Ably in real-time
 * - React 19 concurrent rendering optimized
 * - Lightweight, no external dependencies beyond Tailwind 4
 * 
 * Architecture:
 * 1. Subscribes to ExecutionStepUpdate events from Ably
 * 2. Displays step-by-step progress with status indicators
 * 3. Uses React 19 useOptimistic for instant UI feedback
 * 4. Supports streaming/durable execution visualization
 */

"use client";

import React, { useState, useEffect, useCallback, useOptimistic } from "react";
import { CheckCircle2, Circle, XCircle, Loader2, AlertCircle } from "lucide-react";

// ============================================================================
// TYPES
// ============================================================================

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

export interface StreamingStatusUpdate {
  executionId: string;
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  status: StepStatus;
  message: string;
  timestamp: string;
  traceId?: string;
}

export interface ProgressStepperProps {
  /** Execution ID to track */
  executionId: string;
  /** Initial steps (if known ahead of time) */
  initialSteps?: Array<{
    stepIndex: number;
    stepName: string;
    status: StepStatus;
    message?: string;
    timestamp?: string;
  }>;
  /** Auto-subscribe to Ably updates */
  autoSubscribe?: boolean;
  /** Show trace ID in UI */
  showTraceId?: boolean;
  /** Custom class name */
  className?: string;
  /** Callback when execution completes */
  onComplete?: (executionId: string) => void;
  /** Callback when execution fails */
  onError?: (executionId: string, error: string) => void;
}

export interface StepState {
  stepIndex: number;
  stepName: string;
  status: StepStatus;
  message: string;
  timestamp: string;
  traceId?: string;
}

// ============================================================================
// STATUS ICON MAPPING
// ============================================================================

const StatusIcon: React.FC<{ status: StepStatus; size?: number }> = ({
  status,
  size = 20,
}) => {
  switch (status) {
    case "completed":
      return (
        <CheckCircle2
          className="text-green-500"
          size={size}
          aria-label="Completed"
        />
      );
    case "in_progress":
      return (
        <Loader2
          className="text-blue-500 animate-spin"
          size={size}
          aria-label="In Progress"
        />
      );
    case "failed":
      return (
        <XCircle
          className="text-red-500"
          size={size}
          aria-label="Failed"
        />
      );
    case "pending":
    default:
      return (
        <Circle
          className="text-gray-300"
          size={size}
          aria-label="Pending"
        />
      );
  }
};

// ============================================================================
// STEP ITEM COMPONENT
// Individual step display with status
// ============================================================================

interface StepItemProps {
  step: StepState;
  isActive: boolean;
  showTraceId?: boolean;
}

const StepItem: React.FC<StepItemProps> = React.memo(({
  step,
  isActive,
  showTraceId,
}) => {
  const statusColors: Record<StepStatus, string> = {
    completed: "border-green-500 bg-green-50",
    in_progress: "border-blue-500 bg-blue-50",
    failed: "border-red-500 bg-red-50",
    pending: "border-gray-300 bg-gray-50",
  };

  const textColors: Record<StepStatus, string> = {
    completed: "text-green-700",
    in_progress: "text-blue-700",
    failed: "text-red-700",
    pending: "text-gray-500",
  };

  return (
    <div
      className={`
        flex items-start gap-3 p-3 rounded-lg border-l-4 transition-all
        ${statusColors[step.status]}
        ${isActive ? "shadow-md scale-[1.02]" : ""}
      `}
      role="listitem"
      aria-label={`Step ${step.stepIndex + 1}: ${step.stepName}`}
    >
      <div className="flex-shrink-0 mt-0.5">
        <StatusIcon status={step.status} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${textColors[step.status]}`}>
            {step.stepName}
          </span>
          <span className="text-xs text-gray-400">
            Step {step.stepIndex + 1}
          </span>
        </div>
        {step.message && (
          <p className={`text-sm mt-1 ${textColors[step.status]}`}>
            {step.message}
          </p>
        )}
        {showTraceId && step.traceId && (
          <p className="text-xs text-gray-400 mt-1 font-mono">
            Trace: {step.traceId.slice(0, 8)}...
          </p>
        )}
        <p className="text-xs text-gray-400 mt-1">
          {new Date(step.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
});

StepItem.displayName = "StepItem";

// ============================================================================
// PROGRESS SUMMARY COMPONENT
// Shows overall progress
// ============================================================================

interface ProgressSummaryProps {
  completed: number;
  inProgress: number;
  failed: number;
  total: number;
}

const ProgressSummary: React.FC<ProgressSummaryProps> = ({
  completed,
  inProgress,
  failed,
  total,
}) => {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mb-4 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-700">Progress</h3>
        <span className="text-sm text-gray-500">
          {completed}/{total} steps completed
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className={`h-2.5 rounded-full transition-all duration-300 ${
            failed > 0 ? "bg-red-500" : "bg-green-500"
          }`}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div className="flex gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <CheckCircle2 size={12} className="text-green-500" />
          {completed} completed
        </span>
        <span className="flex items-center gap-1">
          <Loader2 size={12} className="text-blue-500 animate-spin" />
          {inProgress} in progress
        </span>
        <span className="flex items-center gap-1">
          <XCircle size={12} className="text-red-500" />
          {failed} failed
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// STREAMING PROGRESS STEPPER
// Main component
// ============================================================================

export const StreamingProgressStepper: React.FC<ProgressStepperProps> = ({
  executionId,
  initialSteps = [],
  autoSubscribe = true,
  showTraceId = false,
  className = "",
  onComplete,
  onError,
}) => {
  // Use Optimistic UI for instant feedback (React 19)
  const [optimisticSteps, setOptimisticSteps] = useOptimistic(
    initialSteps.map((step, index) => ({
      stepIndex: step.stepIndex ?? index,
      stepName: step.stepName,
      status: step.status,
      message: step.message || "",
      timestamp: step.timestamp || new Date().toISOString(),
      traceId: undefined,
    })),
    (
      state: StepState[],
      update: Partial<StepState> & { stepIndex: number }
    ) => {
      const existingIndex = state.findIndex(
        (s) => s.stepIndex === update.stepIndex
      );

      if (existingIndex >= 0) {
        const newState = [...state];
        newState[existingIndex] = { ...newState[existingIndex], ...update };
        return newState;
      } else {
        return [
          ...state,
          {
            stepIndex: update.stepIndex,
            stepName: update.stepName || `Step ${update.stepIndex + 1}`,
            status: update.status || "pending",
            message: update.message || "",
            timestamp: update.timestamp || new Date().toISOString(),
            traceId: update.traceId,
          } as StepState,
        ];
      }
    }
  );

  const [isConnected, setIsConnected] = useState(autoSubscribe);
  const [error, setError] = useState<string | null>(null);

  // Calculate summary stats
  const stats = {
    completed: optimisticSteps.filter((s) => s.status === "completed").length,
    inProgress: optimisticSteps.filter((s) => s.status === "in_progress").length,
    failed: optimisticSteps.filter((s) => s.status === "failed").length,
    total: Math.max(optimisticSteps.length, 1),
  };

  // Check if execution is complete
  useEffect(() => {
    if (optimisticSteps.length > 0) {
      const allComplete = optimisticSteps.every(
        (s) => s.status === "completed" || s.status === "failed"
      );
      const hasFailed = optimisticSteps.some((s) => s.status === "failed");

      if (allComplete) {
        if (hasFailed && onError) {
          onError(executionId, "One or more steps failed");
        } else if (onComplete) {
          onComplete(executionId);
        }
      }
    }
  }, [optimisticSteps, executionId, onComplete, onError]);

  // Subscribe to Ably updates
  useEffect(() => {
    if (!autoSubscribe) return;

    let subscription: any = null;
    let ably: any = null;

    const connectToAbly = async () => {
      try {
        // Direct Ably initialization for browser compatibility
        const apiKey = process.env.NEXT_PUBLIC_ABLY_API_KEY;
        
        if (!apiKey) {
          console.warn(
            "[StreamingProgressStepper] Ably not configured"
          );
          setIsConnected(false);
          return;
        }

        const Ably = (await import("ably")).default;
        ably = new Ably.Realtime({ key: apiKey });

        const channel = ably.channels.get("nervous-system:updates");

        subscription = await channel.subscribe(
          "ExecutionStepUpdate",
          (message: any) => {
            const update = message.data?.data as StreamingStatusUpdate;

            if (update && update.executionId === executionId) {
              setOptimisticSteps({
                stepIndex: update.stepIndex,
                stepName: update.stepName,
                status: update.status,
                message: update.message,
                timestamp: update.timestamp,
                traceId: update.traceId,
              });
            }
          }
        );

        setIsConnected(true);
        console.log(
          `[StreamingProgressStepper] Subscribed to updates for ${executionId}`
        );
      } catch (err) {
        console.error(
          "[StreamingProgressStepper] Failed to connect to Ably:",
          err
        );
        setError("Failed to connect to real-time updates");
        setIsConnected(false);
      }
    };

    connectToAbly();

    return () => {
      if (subscription && ably) {
        try {
          ably.channels.get("nervous-system:updates").unsubscribe(subscription);
        } catch (err) {
          // Cleanup error, ignore
        }
      }
    };
  }, [executionId, autoSubscribe, setOptimisticSteps]);

  // Handler for manual update (fallback or server-sent events)
  const handleUpdate = useCallback(
    (update: StreamingStatusUpdate) => {
      if (update.executionId === executionId) {
        setOptimisticSteps({
          stepIndex: update.stepIndex,
          stepName: update.stepName,
          status: update.status,
          message: update.message,
          timestamp: update.timestamp,
          traceId: update.traceId,
        });
      }
    },
    [executionId, setOptimisticSteps]
  );

  return (
    <div
      className={`w-full max-w-2xl ${className}`}
      role="region"
      aria-label="Execution Progress"
    >
      {/* Connection Status */}
      <div className="mb-3 flex items-center gap-2 text-xs">
        <div
          className={`w-2 h-2 rounded-full ${
            isConnected ? "bg-green-500" : "bg-gray-400"
          }`}
        />
        <span className="text-gray-600">
          {isConnected ? "Live updates" : "Updates paused"}
        </span>
        {error && (
          <span className="text-red-500 flex items-center gap-1">
            <AlertCircle size={12} />
            {error}
          </span>
        )}
      </div>

      {/* Progress Summary */}
      <ProgressSummary {...stats} />

      {/* Steps List */}
      <div className="space-y-2" role="list">
        {optimisticSteps.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Loader2 className="animate-spin mx-auto mb-2" size={24} />
            <p>Waiting for execution to start...</p>
          </div>
        ) : (
          optimisticSteps
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map((step, index) => (
              <StepItem
                key={step.stepIndex}
                step={step}
                isActive={step.status === "in_progress"}
                showTraceId={showTraceId}
              />
            ))
        )}
      </div>

      {/* Expose handler for parent components */}
      <div className="hidden" data-update-handler={JSON.stringify(handleUpdate)} />
    </div>
  );
};

// ============================================================================
// HOOK FOR PROGRAMMATIC UPDATES
// ============================================================================

export function useStreamingProgress(executionId: string) {
  const [updates, setUpdates] = useState<StreamingStatusUpdate[]>([]);

  const addUpdate = useCallback((update: StreamingStatusUpdate) => {
    setUpdates((prev) => [...prev, update]);
  }, []);

  return {
    updates,
    addUpdate,
    executionId,
  };
}

export default StreamingProgressStepper;
