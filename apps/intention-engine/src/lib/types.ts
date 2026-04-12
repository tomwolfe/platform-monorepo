import { Plan, Intent } from "./engine/types";

export interface AuditLog {
  id: string;
  timestamp: string;
  intent: Intent;
  intent_history?: Intent[]; // History of superseded intents
  plan?: Plan;
  userLocation?: { lat: number; lng: number };
  rawModelResponse?: string;
  inferenceLatencies?: {
    intentInference?: number;
    planGeneration?: number;
    total?: number;
  };
  toolExecutionLatencies?: {
    latencies: { [tool_name: string]: number[] };
    totalToolExecutionTime?: number;
  };
  validation_error?: string;
  efficiency_flag?: "LOW";
  replanned_count?: number;
  metadata?: Record<string, unknown>;
  steps: Array<{
    step_index: number;
    tool_name: string;
    status: "pending" | "executed" | "rejected" | "failed";
    input: unknown;
    output?: unknown;
    error?: string;
    confirmed_by_user?: boolean;
    timestamp: string;
    latency?: number;
  }>;
  final_outcome?: string;
}
