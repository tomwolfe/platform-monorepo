# Intent Ontology

## Overview
This document defines the formal structure and boundaries of "Intent" within the IntentionEngine. Any user input that cannot be mapped to these definitions with high confidence must be rejected or moved to a clarification state.

## Intent Categories

### 1. SCHEDULE
**Definition:** Requests to create, modify, or query time-bound events or reminders.
**Required Parameters:**
- `action`: (CREATE | UPDATE | DELETE | QUERY)
- `temporal_expression`: ISO-8601 string or relative time description.
**Boundary:** Must involve a specific event or time-slot. General desires (e.g., "I want to be more productive") are NOT SCHEDULE intents.

### 2. SEARCH
**Definition:** Retrieval of external information or entities.
**Required Parameters:**
- `query`: The search string.
- `scope`: (LOCAL | GLOBAL | SYSTEM)
**Boundary:** Must have a clear informational target. Vague curiosity (e.g., "Tell me something interesting") is EXCLUDED.

### 3. ACTION
**Definition:** Explicit request to change the state of an integrated system or perform a side-effect.
**Required Parameters:**
- `capability`: The target function or tool.
- `arguments`: Map of required inputs for the capability.
**Boundary:** Must map to a registered Capability. Requests for unsupported actions must be REFUSED.

### 4. QUERY
**Definition:** Request for information about the system's own state, history, or capabilities.
**Required Parameters:**
- `target_object`: The entity being queried.
**Boundary:** Limited to the system's domain. General knowledge questions may be handled by SEARCH or rejected if out-of-scope.

### 5. PLANNING
**Definition:** High-level goals that require decomposition into multiple steps or dependencies.
**Required Parameters:**
- `goal`: The terminal state desired.
**Boundary:** Must be actionable. Abstract life goals (e.g., "Make me happy") are REFUSED.

### 6. ANALYSIS
**Definition:** Requests to process provided information, identify patterns, or summarize data.
**Required Parameters:**
- `context`: The data or reference to data to be analyzed.
**Boundary:** Requires structured or semi-structured input. Cannot "analyze" nothingness.

## Explicit Exclusions
The following are NOT valid intents and must be handled by the REFUSAL protocol:
- **Small Talk:** Greetings, pleasantries, or non-functional conversation.
- **Emotional Support:** Requests for therapy, validation, or emotional labor.
- **Illegal/Harmful:** Requests that violate safety guardrails.
- **Vague Input:** Input where confidence < 0.5 across all categories.

## Refusal Scenarios
1. **Ambiguity:** Multiple hypotheses with similar low confidence.
2. **Out of Scope:** Request clearly falls into Exclusions.
3. **Missing Constraints:** Intent is clear but lacks critical parameters (move to `clarification_needed`).
