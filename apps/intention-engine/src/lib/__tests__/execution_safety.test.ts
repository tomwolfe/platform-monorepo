/**
 * Execution Safety Tests
 * Phase 4: Execution Safety Guardrails
 *
 * Tests:
 * - Low risk actions should not require confirmation
 * - High risk actions MUST require confirmation
 * - Unknown capabilities should be blocked
 */

import { describe, it, expect } from "vitest";
import { normalizeIntent } from "../normalization";
import { createExecutionPlan } from "../execution_plan";

describe("Execution Safety", () => {
  it("Low risk action (calendar.create) should not require confirmation", () => {
    const raw = "add meeting tomorrow";
    const cand = {
      type: "ACTION" as const,
      confidence: 0.9,
      parameters: {
        capability: "calendar.create",
        arguments: { title: "Meeting" },
      },
    };
    const intent = normalizeIntent(cand, raw, "sim-v1");
    const plan = createExecutionPlan(intent);

    expect(plan.requires_total_confirmation).toBe(false);
  });

  it("High risk action (calendar.delete) MUST require confirmation", () => {
    const raw = "delete all my meetings";
    const cand = {
      type: "ACTION" as const,
      confidence: 0.9,
      parameters: {
        capability: "calendar.delete",
        arguments: { all: true },
      },
    };
    const intent = normalizeIntent(cand, raw, "sim-v1");
    const plan = createExecutionPlan(intent);

    expect(plan.requires_total_confirmation).toBe(true);
  });

  it("Unknown capability should be blocked", () => {
    const raw = "hack the planet";
    const cand = {
      type: "ACTION" as const,
      confidence: 0.9,
      parameters: {
        capability: "system.hack",
        arguments: {},
      },
    };
    const intent = normalizeIntent(cand, raw, "sim-v1");
    
    // Unknown capabilities should result in requires_total_confirmation = true
    const plan = createExecutionPlan(intent);
    expect(plan.requires_total_confirmation).toBe(true);
  });
});
