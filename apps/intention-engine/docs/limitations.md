# System Limitations

## 1. Capability Boundary
The system can ONLY execute actions that are explicitly mapped in `guardrails.ts`. It will refuse any request that falls outside this map, even if the intent is clear.

## 2. Multi-Turn Memory
The system now includes recent intent history in the inference context to resolve pronouns and follow-up requests. However, long-term memory and cross-session context are still limited.

## 3. Real-Time Temporal Grounding
The system's understanding of "now" is limited to the timestamp provided at the time of inference. It cannot autonomously monitor time or trigger actions based on temporal drift without external polling.

## 4. Parameter Validation Depth
Initial deep semantic validation has been implemented for `SCHEDULE` intents (e.g., checking for past dates). This remains an area for expansion for other intent types and complex constraints.

## 5. Provider Dependency
The system's candidate generator (LLM) is an external dependency. Significant degradation or changes in the provider's model may impact the initial candidate generation, though the deterministic layers will catch failures.
