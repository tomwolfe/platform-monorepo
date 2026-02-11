# Kill Criteria

## Overview
This document defines the conditions under which the IntentionEngine project must be halted or fundamentally redesigned. Failure to meet these criteria indicates that the system is unsafe for real-world application.

## 1. Determinism Failure
**Criteria:** If identical raw input and system state produce different Intent objects (excluding timestamps/IDs) in more than 1% of test cases.
**Reasoning:** Non-deterministic intent interpretation leads to unpredictable execution and impossible debugging.

## 2. Silent Misinterpretation
**Criteria:** If the system assigns a confidence score > 0.9 to an intent that is later proven (via human audit or formal verification) to be semantically incorrect.
**Reasoning:** High-confidence errors are the most dangerous failure mode in autonomous systems.

## 3. Traceability Breach
**Criteria:** If any side-effect (ACTION) occurs that cannot be mapped back to a uniquely versioned, immutable Intent record in the Audit Log.
**Reasoning:** Without 100% traceability, we cannot ensure accountability or perform root-cause analysis.

## 4. Guardrail Bypass
**Criteria:** If a user can craft an input that successfully triggers an "ACTION" intent while bypassing the "Explicit Exclusions" or "Safety Guardrails" defined in the ontology.
**Reasoning:** Security and safety are non-negotiable.

## 5. Drift Over Time
**Criteria:** If the "Semantic Accuracy" metric (as defined in Phase 5) degrades by more than 5% over a 30-day period without changes to the core code.
**Reasoning:** Indicates instability in the underlying candidate generators (LLMs) or environmental context.

## 6. Logic Overlap
**Criteria:** If two or more Intent Categories in the Ontology are found to have overlapping definitions such that a single input could validly be mapped to both without a clear hierarchy.
**Reasoning:** Ambiguity at the ontology level makes deterministic scoring impossible.
