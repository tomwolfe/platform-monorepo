# System Limitations

## 1. Capability Boundary
The system can ONLY execute actions that are explicitly mapped in `guardrails.ts`. It will refuse any request that falls outside this map, even if the intent is clear.

## 2. Multi-Turn Memory
Currently, the system maintains traceability via `parent_intent_id`, but it does not have a general-purpose "memory" of previous conversations beyond the immediate intent chain.

## 3. Real-Time Temporal Grounding
The system's understanding of "now" is limited to the timestamp provided at the time of inference. It cannot autonomously monitor time or trigger actions based on temporal drift without external polling.

## 4. Parameter Validation Depth
While the system checks for the *presence* of required parameters (Ontology), it does not yet perform deep semantic validation (e.g., checking if a requested meeting time is in the past).

## 5. Provider Dependency
The system's candidate generator (LLM) is an external dependency. Significant degradation or changes in the provider's model may impact the initial candidate generation, though the deterministic layers will catch failures.
