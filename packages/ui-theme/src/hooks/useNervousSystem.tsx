/**
 * Nervous System Hook
 *
 * Provides real-time access to the Ambient Agent state across all apps.
 * Subscribes to Ably channels for saga/execution updates.
 *
 * Features:
 * - Cross-app saga persistence
 * - Real-time status updates via Ably
 * - React 19 optimized with useSyncExternalStore
 */

"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import Ably from "ably";

// ============================================================================
// TYPES
// ============================================================================

export type SagaStatus =
  | "RECEIVED"
  | "PLANNING"
  | "EXECUTING"
  | "AWAITING_CONFIRMATION"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface SagaStep {
  stepIndex: number;
  stepName: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "awaiting_confirmation";
  message?: string;
}

export interface ActiveSaga {
  id: string;
  name: string;
  status: SagaStatus;
  steps: SagaStep[];
  createdAt: string;
  updatedAt: string;
  traceId?: string;
  failoverSuggestion?: FailoverSuggestion;
}

export interface FailoverSuggestion {
  type: "ALTERNATIVE_TIME" | "ALTERNATIVE_RESTAURANT" | "DELIVERY" | "WAITLIST";
  title: string;
  description: string;
  actionRequired: boolean;
  parameters?: Record<string, unknown>;
}

export interface NervousSystemState {
  activeSaga: ActiveSaga | null;
  isConnected: boolean;
  error: string | null;
}

// ============================================================================
// ABLY SUBSCRIPTION STORE
// Uses React's useSyncExternalStore pattern
// ============================================================================

type UnsubscribeFn = () => void;
type SubscribeFn = (onStoreChange: () => void) => UnsubscribeFn;

function createNervousSystemStore(): {
  subscribe: SubscribeFn;
  getSnapshot: () => NervousSystemState;
  getServerSnapshot: () => NervousSystemState;
  publishUpdate: (update: Partial<NervousSystemState>) => void;
} {
  let state: NervousSystemState = {
    activeSaga: null,
    isConnected: false,
    error: null,
  };

  let listeners: Set<() => void> = new Set();

  const store = {
    subscribe: (onStoreChange: () => void): UnsubscribeFn => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },

    getSnapshot: (): NervousSystemState => {
      return state;
    },

    getServerSnapshot: (): NervousSystemState => {
      return {
        activeSaga: null,
        isConnected: false,
        error: null,
      };
    },

    publishUpdate: (update: Partial<NervousSystemState>): void => {
      state = { ...state, ...update };
      listeners.forEach((listener) => listener());
    },
  };

  return store;
}

// Global store instance (shared across all hook instances)
const nervousSystemStore = createNervousSystemStore();

// Module-level Ably instance tracking
let globalAblyInstance: any = null;

// ============================================================================
// MAIN HOOK
// ============================================================================

export interface UseNervousSystemOptions {
  /** Auto-subscribe to Ably updates (default: true) */
  autoSubscribe?: boolean;
  /** Saga ID to track (optional - tracks most recent if not specified) */
  sagaId?: string;
}

export function useNervousSystem(options: UseNervousSystemOptions = {}): NervousSystemState & {
  /** Manually confirm a failover suggestion */
  confirmSuggestion: (suggestionId: string) => Promise<void>;
  /** Dismiss the active saga */
  dismissSaga: () => void;
  /** Refresh connection */
  reconnect: () => Promise<void>;
} {
  const { autoSubscribe = true, sagaId } = options;

  // Get state from external store
  const state = useSyncExternalStore(
    nervousSystemStore.subscribe,
    nervousSystemStore.getSnapshot,
    nervousSystemStore.getServerSnapshot
  );

  // Local state for Ably connection
  const [localError, setLocalError] = useState<string | null>(null);

  // Connect to Ably and subscribe to updates
  useEffect(() => {
    if (!autoSubscribe) return;

    let channel: any = null;
    let ably: any = null;
    let subscription: any = null;
    let isMounted = true;

    const connectToAbly = async () => {
      try {
        // Direct Ably client initialization for browser compatibility
        const apiKey = process.env.NEXT_PUBLIC_ABLY_API_KEY;
        
        if (!apiKey) {
          console.warn("[useNervousSystem] Ably API key not configured");
          if (isMounted) {
            nervousSystemStore.publishUpdate({
              isConnected: false,
              error: "Real-time updates unavailable",
            });
          }
          return;
        }

        ably = new Ably.Realtime({ key: apiKey });
        globalAblyInstance = ably;

        // Subscribe to nervous system updates
        channel = ably.channels.get("nervous-system:updates");

        subscription = await channel.subscribe(
          "ExecutionStepUpdate",
          (message: any) => {
            if (!isMounted) return;

            const update = message.data?.data;
            if (!update) return;

            // Convert execution update to saga format
            const saga: ActiveSaga = {
              id: update.executionId,
              name: update.stepName || "Active Plan",
              status: mapStatusToSagaStatus(update.status),
              steps: [
                {
                  stepIndex: update.stepIndex,
                  stepName: update.stepName,
                  status: update.status,
                  message: update.message,
                },
              ],
              createdAt: update.timestamp,
              updatedAt: new Date().toISOString(),
              traceId: update.traceId,
            };

            nervousSystemStore.publishUpdate({
              activeSaga: saga,
              isConnected: true,
              error: null,
            });
          }
        );

        // Also listen for failover suggestions
        const failoverSubscription = await channel.subscribe(
          "FailoverSuggestion",
          (message: any) => {
            if (!isMounted) return;

            const suggestion = message.data?.data;
            if (!suggestion) return;

            nervousSystemStore.publishUpdate({
              activeSaga: state.activeSaga
                ? {
                    ...state.activeSaga,
                    failoverSuggestion: {
                      type: mapFailoverType(suggestion.action?.type),
                      title: getFailoverTitle(suggestion),
                      description: getFailoverDescription(suggestion),
                      actionRequired: true,
                      parameters: suggestion.action?.parameters,
                    },
                  }
                : null,
            });
          }
        );

        if (isMounted) {
          nervousSystemStore.publishUpdate({ isConnected: true, error: null });
        }

        console.log("[useNervousSystem] Connected to Nervous System");
      } catch (err) {
        console.error("[useNervousSystem] Connection error:", err);
        if (isMounted) {
          const errorMessage =
            err instanceof Error ? err.message : "Connection failed";
          setLocalError(errorMessage);
          nervousSystemStore.publishUpdate({
            isConnected: false,
            error: errorMessage,
          });
        }
      }
    };

    connectToAbly();

    return () => {
      isMounted = false;
      if (subscription && channel) {
        try {
          channel.unsubscribe(subscription);
        } catch {
          // Ignore cleanup errors
        }
      }
    };
  }, [autoSubscribe]);

  // Action handlers
  const confirmSuggestion = useCallback(async (suggestionId: string) => {
    // Publish confirmation back through Ably
    try {
      if (!globalAblyInstance) {
        throw new Error("Ably not connected");
      }
      
      const channel = globalAblyInstance.channels.get("nervous-system:updates");
      await channel.publish("FailoverConfirmation", {
        suggestionId,
        sagaId: state.activeSaga?.id,
        timestamp: new Date().toISOString(),
      });
      console.log("[useNervousSystem] Confirmed suggestion:", suggestionId);
    } catch (err) {
      console.error("[useNervousSystem] Failed to confirm:", err);
      throw err;
    }
  }, [state.activeSaga]);

  const dismissSaga = useCallback(() => {
    nervousSystemStore.publishUpdate({ activeSaga: null });
  }, []);

  const reconnect = useCallback(async () => {
    nervousSystemStore.publishUpdate({
      isConnected: false,
      error: null,
    });
    // Trigger reconnection by toggling autoSubscribe
    setLocalError(null);
  }, []);

  return {
    ...state,
    confirmSuggestion,
    dismissSaga,
    reconnect,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function mapStatusToSagaStatus(
  status: string
): SagaStatus {
  switch (status) {
    case "pending":
    case "RECEIVED":
      return "RECEIVED";
    case "in_progress":
      return "EXECUTING";
    case "awaiting_confirmation":
      return "AWAITING_CONFIRMATION";
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    default:
      return "EXECUTING";
  }
}

function mapFailoverType(actionType?: string): FailoverSuggestion["type"] {
  switch (actionType) {
    case "SUGGEST_ALTERNATIVE_TIME":
      return "ALTERNATIVE_TIME";
    case "SUGGEST_ALTERNATIVE_RESTAURANT":
      return "ALTERNATIVE_RESTAURANT";
    case "TRIGGER_DELIVERY":
      return "DELIVERY";
    case "TRIGGER_WAITLIST":
      return "WAITLIST";
    default:
      return "ALTERNATIVE_TIME";
  }
}

function getFailoverTitle(suggestion: any): string {
  const action = suggestion.action?.type;
  switch (action) {
    case "SUGGEST_ALTERNATIVE_TIME":
      return "⏰ Alternative Time Available";
    case "SUGGEST_ALTERNATIVE_RESTAURANT":
      return "🍽️ Alternative Restaurant";
    case "TRIGGER_DELIVERY":
      return "🚗 Delivery Available";
    case "TRIGGER_WAITLIST":
      return "📋 Join Waitlist";
    default:
      return "⚠️ Adjustment Needed";
  }
}

function getFailoverDescription(suggestion: any): string {
  const template = suggestion.action?.message_template;
  if (template) {
    // Simple template interpolation
    return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
      return String(suggestion.context?.[key] || key);
    });
  }
  return "An alternative is available. Tap to proceed.";
}

// ============================================================================
// PROVIDER COMPONENT
// Wraps the hook with context for easier consumption
// ============================================================================

import { createContext, useContext, type ReactNode } from "react";

const NervousSystemContext = createContext<ReturnType<
  typeof useNervousSystem
> | null>(null);

export interface NervousSystemProviderProps {
  children: ReactNode;
  autoSubscribe?: boolean;
}

export function NervousSystemProvider({
  children,
  autoSubscribe = true,
}: NervousSystemProviderProps) {
  const nervousSystem = useNervousSystem({ autoSubscribe });

  return (
    <NervousSystemContext.Provider value={nervousSystem}>
      {children}
    </NervousSystemContext.Provider>
  );
}

export function useNervousSystemContext() {
  const context = useContext(NervousSystemContext);
  if (!context) {
    throw new Error(
      "useNervousSystemContext must be used within a NervousSystemProvider"
    );
  }
  return context;
}

export default useNervousSystem;
