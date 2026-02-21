/**
 * Normalization Service
 * Validates raw LLM output against McpToolRegistry schemas
 * Provides deterministic guardrails against "Confidence Inflation"
 * 
 * Integrated with Schema Evolution Service to automatically record
 * parameter mismatches for continuous schema improvement.
 */

import { z } from "zod";
import { TOOLS, McpToolRegistry } from "@repo/mcp-protocol";
import type { SchemaEvolutionService } from "./services/schema-evolution";

export interface NormalizationResult<T = unknown> {
  success: boolean;
  data?: T;
  errors: NormalizationError[];
  rawInput: unknown;
  // Schema evolution tracking
  mismatchRecorded?: boolean;
  mismatchEventId?: string;
}

export interface NormalizationError {
  path: string;
  message: string;
  code: string;
}

/**
 * NormalizationService
 *
 * Takes raw LLM output and validates it against the McpToolRegistry schemas.
 * This overrides LLM "Confidence Inflation" with deterministic Zod failures.
 * 
 * When schema evolution service is provided, automatically records mismatches
 * to enable self-healing schema evolution.
 */
export class NormalizationService {
  // Optional schema evolution service for automatic mismatch tracking
  private static schemaEvolutionService: SchemaEvolutionService | null = null;

  /**
   * Initialize the normalization service with schema evolution tracking
   */
  static initialize(options?: {
    schemaEvolutionService?: SchemaEvolutionService;
  }): void {
    if (options?.schemaEvolutionService) {
      this.schemaEvolutionService = options.schemaEvolutionService;
      console.log("[NormalizationService] Schema evolution tracking enabled");
    }
  }

  /**
   * Get all available schemas from the McpToolRegistry
   */
  private static getAllSchemas(): Map<string, z.ZodType<any>> {
    const schemas = new Map<string, z.ZodType<any>>();
    
    // Flatten the TOOLS registry
    const toolEntries = Object.entries(TOOLS);
    
    for (const [, serviceTools] of toolEntries) {
      const serviceToolEntries = Object.entries(serviceTools);
      for (const [toolName, toolDef] of serviceToolEntries) {
        if (toolDef && typeof toolDef === 'object' && 'schema' in toolDef) {
          schemas.set(toolDef.name as string, toolDef.schema as z.ZodType<any>);
        }
      }
    }
    
    return schemas;
  }

  /**
   * Validate raw LLM output against a specific tool schema
   * 
   * @param toolName - The name of the tool to validate against
   * @param rawOutput - The raw LLM output to validate
   * @returns NormalizationResult with validation status
   */
  static validateToolParameters(
    toolName: string,
    rawOutput: unknown
  ): NormalizationResult {
    const schemas = this.getAllSchemas();
    const schema = schemas.get(toolName);
    
    if (!schema) {
      return {
        success: false,
        errors: [{
          path: "tool",
          message: `Unknown tool: ${toolName}`,
          code: "UNKNOWN_TOOL"
        }],
        rawInput: rawOutput
      };
    }

    const result = schema.safeParse(rawOutput);
    
    if (result.success) {
      return {
        success: true,
        data: result.data,
        errors: [],
        rawInput: rawOutput
      };
    } else {
      const errors: NormalizationError[] = result.error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message,
        code: err.code
      }));
      
      return {
        success: false,
        errors,
        rawInput: rawOutput
      };
    }
  }

  /**
   * Attempt to validate against all known tool schemas
   * Returns the first successful match or all failures
   * 
   * @param rawOutput - The raw LLM output to validate
   * @returns NormalizationResult with the best matching schema
   */
  static validateAgainstAllTools(
    rawOutput: unknown
  ): NormalizationResult & { matchedTool?: string } {
    const schemas = this.getAllSchemas();
    const allErrors: Array<{ tool: string; errors: NormalizationError[] }> = [];
    
    for (const [toolName, schema] of Array.from(schemas.entries())) {
      const result = schema.safeParse(rawOutput);
      
      if (result.success) {
        return {
          success: true,
          data: result.data,
          errors: [],
          rawInput: rawOutput,
          matchedTool: toolName
        };
      } else {
        const errors: NormalizationError[] = result.error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message,
          code: err.code
        }));
        allErrors.push({ tool: toolName, errors });
      }
    }
    
    // No schema matched - return aggregate errors
    return {
      success: false,
      errors: allErrors.flatMap(e => e.errors.map(err => ({
        ...err,
        path: `${e.tool}.${err.path}`
      }))),
      rawInput: rawOutput
    };
  }

  /**
   * Normalize intent parameters against known tool schemas
   * This is the primary method for Phase 3 guardrails
   *
   * @param intentType - The inferred intent type
   * @param parameters - The raw parameters from LLM
   * @returns Normalized and validated parameters
   */
  static normalizeIntentParameters(
    intentType: string,
    parameters: Record<string, unknown>
  ): NormalizationResult {
    // Map intent types to likely tools
    const intentToolMap: Record<string, string[]> = {
      "SCHEDULE": ["add_calendar_event"],
      "BOOKING": ["reserve_restaurant", "bookTable"],
      "MOBILITY": ["request_ride", "get_route_estimate"],
      "DELIVERY": ["calculateQuote"],
      "SEARCH": ["search_restaurant", "listVendors", "find_product_nearby"],
      "COMMUNICATION": ["send_comm"],
      "WEATHER": ["get_weather_data"],
      "OPERATIONAL": ["getLiveOperationalState"],
    };

    const candidateTools = intentToolMap[intentType] || [];

    // Try to validate against candidate tools
    for (const toolName of candidateTools) {
      const result = this.validateToolParameters(toolName, parameters);
      if (result.success) {
        return result;
      }
    }

    // If no candidate matched, try all tools
    const result = this.validateAgainstAllTools(parameters);

    // RECORD MISMATCH FOR SCHEMA EVOLUTION
    // When schema evolution is enabled and validation fails, record the mismatch
    if (!result.success && this.schemaEvolutionService) {
      try {
        // Extract field information from errors
        const expectedFields = new Set<string>();
        const unexpectedFields = new Set<string>();

        for (const error of result.errors) {
          const fieldPath = error.path.split('.')[0];
          if (error.code === "unrecognized_keys" || error.message.includes("unrecognized")) {
            unexpectedFields.add(fieldPath);
          } else if (error.code === "invalid_type" || error.code === "required") {
            expectedFields.add(fieldPath);
          }
        }

        // Record the mismatch event (async, non-blocking)
        this.schemaEvolutionService.recordMismatch({
          intentType,
          toolName: "unknown", // Could be improved with better tool detection
          timestamp: new Date().toISOString(),
          llmParameters: parameters,
          expectedFields: Array.from(expectedFields),
          unexpectedFields: Array.from(unexpectedFields),
          missingFields: Array.from(expectedFields),
          errors: result.errors.map(e => ({
            field: e.path,
            message: e.message,
            code: e.code,
          })),
        }).then(event => {
          result.mismatchRecorded = true;
          result.mismatchEventId = event.id;
        }).catch(err => {
          console.warn("[NormalizationService] Failed to record mismatch:", err);
        });
      } catch (evolutionError) {
        // Silently fail - schema evolution is optional
        console.warn("[NormalizationService] Schema evolution recording failed:", evolutionError);
      }
    }

    return result;
  }

  /**
   * Strict validation that throws on failure
   * Use this when you want to enforce hard failures on invalid LLM output
   * 
   * @param toolName - The tool to validate against
   * @param rawOutput - The raw LLM output
   * @returns The validated data
   * @throws Error if validation fails
   */
  static validateStrict<T = unknown>(toolName: string, rawOutput: unknown): T {
    const result = this.validateToolParameters(toolName, rawOutput);
    
    if (!result.success) {
      const errorMessages = result.errors.map(e => `${e.path}: ${e.message}`).join(', ');
      throw new Error(`Validation failed for ${toolName}: ${errorMessages}`);
    }
    
    return result.data as T;
  }
}
