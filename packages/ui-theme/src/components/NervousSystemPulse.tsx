/**
 * Nervous System Pulse
 *
 * The "Ambient Agent" HUD - A universal status & action bar that appears
 * across all apps in the monorepo when an autonomous agent is active.
 *
 * Features:
 * - Cross-app saga persistence (saga continues even when navigating between apps)
 * - Real-time progress visualization
 * - Actionable failover suggestions with one-tap confirmation
 * - Minimizes to show progress dots when user is in another app
 *
 * Architecture:
 * - Uses NervousSystemProvider context for state
 * - Subscribes to Ably channels for real-time updates
 * - Leverages StreamingProgressStepper for step visualization
 * - Tailwind 4 for lightweight, responsive styling
 */

"use client";

import React, { useState, useCallback } from "react";
import { CheckCircle2, Circle, Loader2, XCircle, Bell, BellOff, ChevronDown, ChevronUp, Zap } from "lucide-react";
import { useNervousSystemContext, NervousSystemProvider } from "../hooks/useNervousSystem";
import { StreamingProgressStepper } from "./StreamingProgressStepper";
import { Button } from "./ui/button";

// ============================================================================
// TYPES
// ============================================================================

interface NervousSystemPulseInternalProps {
  /** Custom class name for outer container */
  className?: string;
  /** Auto-minimize after inactivity (ms) */
  autoMinimizeDelay?: number;
  /** Show detailed progress or just status dots */
  expanded?: boolean;
  /** Callback when saga completes */
  onComplete?: (sagaId: string) => void;
  /** Callback when user confirms a failover suggestion */
  onConfirmSuggestion?: (suggestionId: string) => void;
}

// ============================================================================
// PULSE COMPONENT (Internal - requires context)
// ============================================================================

const NervousSystemPulseInternal: React.FC<NervousSystemPulseInternalProps> = ({
  className = "",
  autoMinimizeDelay = 10000,
  expanded: controlledExpanded,
  onComplete,
  onConfirmSuggestion,
}) => {
  const { activeSaga, isConnected, error, confirmSuggestion, dismissSaga } =
    useNervousSystemContext();

  const [isMinimized, setIsMinimized] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lastActivity, setLastActivity] = useState(Date.now());

  // Auto-minimize after inactivity
  React.useEffect(() => {
    if (!activeSaga) return;

    const timer = setInterval(() => {
      if (Date.now() - lastActivity > autoMinimizeDelay) {
        setIsMinimized(true);
      }
    }, 5000);

    return () => clearInterval(timer);
  }, [activeSaga, lastActivity, autoMinimizeDelay]);

  // Reset activity timer on user interaction
  const handleUserInteraction = useCallback(() => {
    setLastActivity(Date.now());
    setIsMinimized(false);
  }, []);

  // Handle suggestion confirmation
  const handleConfirm = useCallback(async () => {
    if (!activeSaga?.failoverSuggestion) return;

    try {
      await confirmSuggestion(activeSaga.id);
      onConfirmSuggestion?.(activeSaga.id);
      setLastActivity(Date.now());
    } catch (err) {
      console.error("[NervousSystemPulse] Failed to confirm:", err);
    }
  }, [activeSaga, confirmSuggestion, onConfirmSuggestion]);

  // Handle completion
  const handleComplete = useCallback(
    (sagaId: string) => {
      onComplete?.(sagaId);
      // Auto-dismiss after completion
      setTimeout(() => {
        dismissSaga();
      }, 3000);
    },
    [onComplete, dismissSaga]
  );

  // Don't render if no active saga
  if (!activeSaga) return null;

  // Determine status color and icon
  const getStatusColor = () => {
    if (activeSaga.failoverSuggestion) return "bg-amber-500 border-amber-500/50";
    switch (activeSaga.status) {
      case "COMPLETED":
        return "bg-green-500 border-green-500/50";
      case "FAILED":
      case "CANCELLED":
        return "bg-red-500 border-red-500/50";
      case "AWAITING_CONFIRMATION":
        return "bg-amber-500 border-amber-500/50";
      case "EXECUTING":
      case "PLANNING":
        return "bg-emerald-500 border-emerald-500/50";
      default:
        return "bg-blue-500 border-blue-500/50";
    }
  };

  const getStatusIcon = () => {
    if (activeSaga.failoverSuggestion) return "⚠️";
    switch (activeSaga.status) {
      case "COMPLETED":
        return "✅";
      case "FAILED":
      case "CANCELLED":
        return "❌";
      case "AWAITING_CONFIRMATION":
        return "⏸️";
      case "EXECUTING":
      case "PLANNING":
        return "🤖";
      default:
        return "⚙️";
    }
  };

  // Render minimized view (just status dots)
  if (isMinimized && !controlledExpanded) {
    return (
      <div
        className={`fixed bottom-4 right-4 flex items-center gap-2 px-4 py-3 rounded-2xl shadow-2xl backdrop-blur-md z-50 cursor-pointer transition-all hover:scale-105 ${getStatusColor()} bg-black/80 text-white border`}
        onClick={handleUserInteraction}
        role="button"
        aria-label="Active agent - click to expand"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            handleUserInteraction();
          }
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{getStatusIcon()}</span>
          <div className="flex gap-1">
            {activeSaga.steps.slice(0, 4).map((step, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-all ${
                  step.status === "completed"
                    ? "bg-green-400"
                    : step.status === "in_progress"
                    ? "bg-amber-400 animate-pulse"
                    : step.status === "failed"
                    ? "bg-red-400"
                    : "bg-gray-600"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Render expanded view
  return (
    <div
      className={`fixed bottom-4 right-4 w-96 max-h-[80vh] overflow-y-auto bg-black/90 text-white p-4 rounded-2xl shadow-2xl backdrop-blur-md z-50 border ${getStatusColor()} ${className}`}
      role="region"
      aria-label="Agent Status"
      onMouseEnter={handleUserInteraction}
      onTouchStart={handleUserInteraction}
    >
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500 animate-pulse" : "bg-gray-500"}`}
          />
          <span className="text-xs font-bold tracking-tighter uppercase text-gray-300">
            {isConnected ? "Agent Active" : "Connecting..."}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-gray-400 hover:text-white"
            onClick={() => setIsMinimized(true)}
            aria-label="Minimize"
          >
            <ChevronDown size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-gray-400 hover:text-red-400"
            onClick={dismissSaga}
            aria-label="Dismiss"
          >
            <XCircle size={14} />
          </Button>
        </div>
      </div>

      {/* Saga Info */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl">{getStatusIcon()}</span>
          <div>
            <h3 className="text-sm font-bold text-white">
              {activeSaga.name || "Active Plan"}
            </h3>
            <p className="text-xs text-gray-400 capitalize">
              Status: {activeSaga.status.replace("_", " ")}
            </p>
          </div>
        </div>
      </div>

      {/* Failover Suggestion (Priority Display) */}
      {activeSaga.failoverSuggestion && (
        <div className="mb-4 p-3 bg-amber-500/20 border border-amber-500/50 rounded-lg">
          <div className="flex items-start gap-2 mb-2">
            <Zap size={16} className="text-amber-400 mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-amber-200">
                {activeSaga.failoverSuggestion.title}
              </h4>
              <p className="text-xs text-amber-100/80 mt-1">
                {activeSaga.failoverSuggestion.description}
              </p>
            </div>
          </div>
          {activeSaga.failoverSuggestion.actionRequired && (
            <Button
              size="sm"
              className="w-full bg-amber-600 hover:bg-amber-700 text-white"
              onClick={handleConfirm}
            >
              Confirm Alternative
            </Button>
          )}
        </div>
      )}

      {/* Progress Stepper */}
      <div className="mb-3">
        <StreamingProgressStepper
          executionId={activeSaga.id}
          initialSteps={activeSaga.steps.map((s) => ({
            stepIndex: s.stepIndex,
            stepName: s.stepName,
            status: s.status === "awaiting_confirmation" ? "in_progress" : s.status,
            message: s.message,
          }))}
          autoSubscribe={true}
          className="scale-90 origin-center"
          onComplete={handleComplete}
        />
      </div>

      {/* Error State */}
      {error && (
        <div className="mt-3 p-2 bg-red-500/20 border border-red-500/50 rounded text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Footer Actions */}
      <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-700">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-gray-400 hover:text-white"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show Less" : "Show Details"}
          {isExpanded ? <ChevronDown size={12} className="ml-1" /> : <ChevronUp size={12} className="ml-1" />}
        </Button>
        {activeSaga.traceId && (
          <span className="text-xs text-gray-500 font-mono">
            Trace: {activeSaga.traceId.slice(0, 8)}...
          </span>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// MAIN EXPORT (Wrapped with Provider)
// ============================================================================

export interface NervousSystemPulseProps extends NervousSystemPulseInternalProps {
  /** Enable NervousSystemProvider wrapper (default: true for root layouts) */
  includeProvider?: boolean;
}

export const NervousSystemPulse: React.FC<NervousSystemPulseProps> = ({
  includeProvider = true,
  ...props
}) => {
  if (includeProvider) {
    return (
      <NervousSystemProvider autoSubscribe={true}>
        <NervousSystemPulseInternal {...props} />
      </NervousSystemProvider>
    );
  }

  return <NervousSystemPulseInternal {...props} />;
};

// ============================================================================
// LIGHTWEIGHT VERSION (Status Bar Only)
// For apps that want minimal integration
// ============================================================================

export const NervousSystemStatusBar: React.FC<{ className?: string }> = ({
  className = "",
}) => {
  return (
    <NervousSystemProvider>
      <NervousSystemPulseInternal
        className={className}
        autoMinimizeDelay={5000}
        expanded={false}
      />
    </NervousSystemProvider>
  );
};

export default NervousSystemPulse;
