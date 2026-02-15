import { redis } from "./redis-client";

export interface ExecutionStep {
  tool_name: string;
  [key: string]: any;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
}

export interface ExecutionState {
  execution_id: string;
  status: string;
  plan?: ExecutionPlan;
  current_step_index: number;
}

export async function getIntentionEngineState(executionId: string): Promise<ExecutionState | null> {
  // Key format used by IntentionEngine (assuming based on standard patterns)
  const key = `intention:execution:${executionId}`;
  const state = await redis.get<ExecutionState>(key);
  return state;
}

export async function getActiveDeliveryPlan(executionId: string) {
  const state = await getIntentionEngineState(executionId);
  if (!state || !state.plan) return null;

  // Filter steps related to OpenDeliver
  const deliverySteps = state.plan.steps.filter(step => 
    step.tool_name.startsWith("opendeliver") || 
    ["get_local_vendors", "quote_delivery", "dispatch_intent"].includes(step.tool_name)
  );

  return {
    execution_id: state.execution_id,
    status: state.status,
    steps: deliverySteps,
    current_step: state.current_step_index
  };
}
