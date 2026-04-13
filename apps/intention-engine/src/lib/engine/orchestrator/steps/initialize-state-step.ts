/**
 * Initialize State Step
 *
 * Creates the initial execution state, discovers remote tools,
 * and persists the state to memory.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
} from "../step-registry-types";
import { getRegistryManager } from "@/lib/engine/registry";
import { createInitialState } from "@/lib/engine/state-machine";
import { saveExecutionState } from "@/lib/engine/memory";
import { createTracer } from "@/lib/engine/tracing";

export class InitializeStateStep implements OrchestrationStep {
  name = "initialize_state";

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    // Discover remote tools
    const registryManager = getRegistryManager();
    await registryManager.discoverRemoteTools();

    // Create initial state
    const state = createInitialState(context.executionId);

    // Persist initial state
    await saveExecutionState(state);

    // Add trace entry
    const tracer = createTracer(context.executionId);
    tracer.addStateTransitionEntry("none", "RECEIVED", true);
    tracer.addSystemEntry("execution_started", {
      input: context.input.slice(0, 100),
    });

    return {
      ...context,
      state,
    };
  }

  async rollback(context: OrchestrationContext): Promise<void> {
    // State initialization is idempotent - no compensation needed
    // If this step fails, no state was persisted yet
  }
}
