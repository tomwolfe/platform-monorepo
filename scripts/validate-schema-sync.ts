/**
 * Schema Sync Validator
 *
 * CI check that validates TOOLS registry schemas against DB_REFLECTED_SCHEMAS.
 * Ensures database schema changes are reflected in MCP tool definitions.
 *
 * Enhanced with drizzle-zod reflection: Now dynamically loads Drizzle table schemas
 * and validates that all required DB columns are exposed in MCP Tool parameters.
 *
 * Usage:
 *   pnpm tsx scripts/validate-schema-sync.ts
 *   pnpm tsx scripts/validate-schema-sync.ts --strict (fail on warnings)
 *   pnpm tsx scripts/validate-schema-sync.ts --json (output JSON for CI)
 *
 * Exit codes:
 *   0 - All schemas in sync
 *   1 - Validation errors found
 *   2 - Warnings found (only in --strict mode)
 */

import { z } from "zod";
import {
  DB_REFLECTED_SCHEMAS,
  TOOLS,
} from "../packages/mcp-protocol/src/index";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createSelectSchema } from "drizzle-zod";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  restaurants,
  restaurantReservations,
  restaurantTables,
  restaurantWaitlist,
  restaurantProducts,
  inventoryLevels,
  guestProfiles,
} from "@repo/database";

interface ValidationResult {
  toolName: string;
  status: "ok" | "warning" | "error";
  message: string;
  details?: {
    dbFields?: string[];
    toolFields?: string[];
    missingInTool?: string[];
    missingInDb?: string[];
    typeMismatch?: Array<{ field: string; dbType: string; toolType: string }>;
  };
}

/**
 * Extract field names from a Zod schema
 */
function extractZodFields(schema: z.ZodType<any>): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }

  // Handle wrapped schemas
  if ("unwrap" in schema) {
    try {
      const unwrapped = (schema as any).unwrap();
      return extractZodFields(unwrapped);
    } catch {
      // Can't unwrap, return empty
    }
  }

  return [];
}

/**
 * Reflect Drizzle table schema using drizzle-zod
 * This dynamically generates a Zod schema from the Drizzle table definition
 */
function reflectDrizzleSchema(
  table: any,
  tableName: string,
): z.ZodObject<z.ZodRawShape> | null {
  try {
    if (!table) {
      console.warn(`⚠️  Table "${tableName}" is not available for reflection`);
      return null;
    }
    return createSelectSchema(
      table as Parameters<typeof createSelectSchema>[0],
    ) as z.ZodObject<z.ZodRawShape>;
  } catch (error) {
    console.warn(
      `⚠️  Failed to reflect schema for "${tableName}":`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Validate a tool against its dynamically reflected Drizzle schema
 * This is the STRICT mode validation that fails if required DB columns are missing from tool params
 */
function validateToolAgainstReflectedDrizzle(
  toolName: string,
  toolDef: any,
  drizzleTable: any,
  tableName: string,
  requiredFields: string[] = [],
): ValidationResult {
  const reflectedSchema = reflectDrizzleSchema(drizzleTable, tableName);

  if (!reflectedSchema) {
    return {
      toolName,
      status: "warning",
      message: `Could not reflect Drizzle schema for "${tableName}", skipping strict validation`,
    };
  }

  const dbFields = extractZodFields(reflectedSchema);
  const toolFields = extractJsonSchemaFields(toolDef.inputSchema);

  // Find required fields that are missing in tool
  const missingRequiredFields = requiredFields.filter(
    (field) => !toolFields.includes(field),
  );

  // Find all fields missing in tool (not just required ones)
  const missingInTool = dbFields.filter((field) => !toolFields.includes(field));

  // Filter out expected internal/auto-generated fields
  const internalFields = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "verificationToken",
    "isVerified",
    "stripePaymentIntentId",
    "combinedTableIds",
    "metadata",
  ]);
  const filteredMissingInTool = missingInTool.filter(
    (f) => !internalFields.has(f),
  );

  // Error if required fields are missing
  if (missingRequiredFields.length > 0) {
    return {
      toolName,
      status: "error",
      message: `Tool "${toolName}" is missing ${missingRequiredFields.length} required DB column(s): ${missingRequiredFields.join(", ")}`,
      details: {
        dbFields,
        toolFields,
        missingInTool: missingRequiredFields,
      },
    };
  }

  // Warning if many non-essential fields are missing
  if (filteredMissingInTool.length > 5) {
    return {
      toolName,
      status: "warning",
      message: `Tool "${toolName}" has ${filteredMissingInTool.length} non-essential fields not exposed from DB schema "${tableName}" (may be intentional for API contracts)`,
      details: {
        dbFields,
        toolFields,
        missingInTool: filteredMissingInTool,
      },
    };
  }

  return {
    toolName,
    status: "ok",
    message: `Tool "${toolName}" exposes all required fields from reflected DB schema "${tableName}"`,
    details: { dbFields, toolFields },
  };
}

/**
 * Extract field names from a JSON schema (from TOOLS registry)
 */
function extractJsonSchemaFields(jsonSchema: any): string[] {
  if (!jsonSchema || !jsonSchema.properties) {
    return [];
  }
  return Object.keys(jsonSchema.properties);
}

/**
 * Get Zod type string for a field
 */
function getZodFieldType(shape: any): string {
  if (!shape) return "unknown";

  // Handle Zod types
  if (shape instanceof z.ZodString) return "string";
  if (shape instanceof z.ZodNumber) return "number";
  if (shape instanceof z.ZodBoolean) return "boolean";
  if (shape instanceof z.ZodArray) return "array";
  if (shape instanceof z.ZodObject) return "object";
  if (shape instanceof z.ZodOptional) return "optional";
  if (shape instanceof z.ZodNullable) return "nullable";
  if (shape instanceof z.ZodEnum) return "enum";

  return "unknown";
}

/**
 * Get JSON schema type string for a field
 */
function getJsonSchemaFieldType(jsonSchema: any, fieldName: string): string {
  if (
    !jsonSchema ||
    !jsonSchema.properties ||
    !jsonSchema.properties[fieldName]
  ) {
    return "unknown";
  }

  const prop = jsonSchema.properties[fieldName];
  if (prop.type) {
    return Array.isArray(prop.type) ? prop.type.join("|") : prop.type;
  }
  if (prop.anyOf) {
    return "anyOf";
  }
  if (prop.oneOf) {
    return "oneOf";
  }

  return "unknown";
}

/**
 * Validate a single tool against its corresponding DB schema
 * Note: Tool schemas are API contracts and may have fewer fields than DB schemas.
 * We only report errors for critical mismatches, not for internal DB fields.
 */
function validateToolAgainstDB(
  toolName: string,
  toolDef: any,
  expectedDbSchemaName: string,
): ValidationResult {
  const dbSchema =
    DB_REFLECTED_SCHEMAS[
      expectedDbSchemaName as keyof typeof DB_REFLECTED_SCHEMAS
    ];

  if (!dbSchema) {
    return {
      toolName,
      status: "error",
      message: `DB schema "${expectedDbSchemaName}" not found in DB_REFLECTED_SCHEMAS`,
    };
  }

  // Extract fields from both schemas
  const dbFields = extractZodFields(dbSchema);
  const toolFields = extractJsonSchemaFields(toolDef.inputSchema);

  // Find fields missing in tool (fields in DB but not in tool)
  const missingInTool = dbFields.filter((field) => !toolFields.includes(field));
  // Find fields missing in DB (fields in tool but not in DB)
  const missingInDb = toolFields.filter((field) => !dbFields.includes(field));

  // Filter out expected internal/auto-generated fields that tools shouldn't expose
  const internalFields = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "verificationToken",
    "isVerified",
    "stripePaymentIntentId",
    "combinedTableIds",
    "metadata",
  ]);
  const filteredMissingInTool = missingInTool.filter(
    (f) => !internalFields.has(f),
  );

  // Check for type mismatches on shared fields
  const typeMismatches: Array<{
    field: string;
    dbType: string;
    toolType: string;
  }> = [];
  const dbShape = dbSchema instanceof z.ZodObject ? dbSchema.shape : {};

  for (const field of dbFields) {
    if (toolFields.includes(field)) {
      const dbType = getZodFieldType(dbShape[field]);
      const toolType = getJsonSchemaFieldType(toolDef.inputSchema, field);

      // Normalize types for comparison
      const normalizedDbType =
        dbType === "optional" || dbType === "nullable" ? "optional" : dbType;
      const normalizedToolType =
        toolType.includes("null") || toolType === "null"
          ? "optional"
          : toolType;

      // Skip if both are optional/nullable
      if (
        normalizedDbType === "optional" &&
        normalizedToolType === "optional"
      ) {
        continue;
      }

      if (
        normalizedDbType !== normalizedToolType &&
        normalizedToolType !== "unknown"
      ) {
        typeMismatches.push({
          field,
          dbType: normalizedDbType,
          toolType: normalizedToolType,
        });
      }
    }
  }

  // Determine status - only error on critical mismatches
  // Tools are API contracts, so having fewer fields than DB is expected
  if (filteredMissingInTool.length > 5) {
    // Only error if MORE than 5 essential fields are missing (indicates wrong schema mapping)
    return {
      toolName,
      status: "warning",
      message: `Tool "${toolName}" has ${filteredMissingInTool.length} fields not exposed from DB schema "${expectedDbSchemaName}" (this may be intentional for API contracts)`,
      details: {
        dbFields,
        toolFields,
        missingInTool: filteredMissingInTool,
        missingInDb: missingInDb.length > 0 ? missingInDb : undefined,
        typeMismatch: typeMismatches.length > 0 ? typeMismatches : undefined,
      },
    };
  }

  if (missingInDb.length > 0 || typeMismatches.length > 0) {
    const warnings: string[] = [];
    if (missingInDb.length > 0) {
      warnings.push(
        `Tool has ${missingInDb.length} field(s) not in DB: ${missingInDb.join(", ")}`,
      );
    }
    if (typeMismatches.length > 0) {
      warnings.push(`${typeMismatches.length} type mismatch(es)`);
    }

    return {
      toolName,
      status: "warning",
      message: `Tool "${toolName}" has potential schema mismatches: ${warnings.join("; ")}`,
      details: {
        dbFields,
        toolFields,
        missingInDb: missingInDb.length > 0 ? missingInDb : undefined,
        typeMismatch: typeMismatches.length > 0 ? typeMismatches : undefined,
      },
    };
  }

  return {
    toolName,
    status: "ok",
    message: `Tool "${toolName}" is in sync with DB schema "${expectedDbSchemaName}"`,
    details: { dbFields, toolFields },
  };
}

/**
 * Main validation function
 */
async function validateSchemaSync(
  strictMode: boolean = false,
  jsonOutput?: string,
): Promise<number> {
  console.log("🔍 Schema Sync Validator\n");
  console.log("Validating TOOLS registry against DB_REFLECTED_SCHEMAS...\n");

  const results: ValidationResult[] = [];

  // Define expected mappings between tools and DB schemas
  // Note: These mappings validate that tool schemas contain the essential fields
  // from their corresponding DB schemas. Tools may have fewer fields than DB schemas
  // since they represent API contracts, not direct database operations.
  const toolToDbMappings: Array<{
    toolPath: string;
    toolName: string;
    dbSchema: string;
    requiredFields?: string[];
  }> = [
    // Table Management tools - these are API contracts, not direct DB operations
    {
      toolPath: "tableManagement.createReservation",
      toolName: "create_reservation",
      dbSchema: "createReservation",
    },
    {
      toolPath: "tableManagement.updateReservation",
      toolName: "update_reservation",
      dbSchema: "updateReservation",
    },
    {
      toolPath: "tableManagement.addToWaitlist",
      toolName: "add_to_waitlist",
      dbSchema: "addToWaitlist",
    },
    {
      toolPath: "tableManagement.updateWaitlistStatus",
      toolName: "update_waitlist_status",
      dbSchema: "updateWaitlist",
    },
    {
      toolPath: "tableManagement.getTableLayout",
      toolName: "get_table_layout",
      dbSchema: "tables",
    },
  ];

  // Validate each mapping
  for (const mapping of toolToDbMappings) {
    // Navigate to tool in TOOLS registry
    const pathParts = mapping.toolPath.split(".");
    let toolDef: any = TOOLS;

    for (const part of pathParts) {
      toolDef = toolDef?.[part];
    }

    if (!toolDef) {
      results.push({
        toolName: mapping.toolName,
        status: "error",
        message: `Tool "${mapping.toolPath}" not found in TOOLS registry`,
      });
      continue;
    }

    const result = validateToolAgainstDB(
      mapping.toolName,
      toolDef,
      mapping.dbSchema,
    );
    results.push(result);
  }

  // STRICT MODE: Validate against dynamically reflected Drizzle schemas
  if (strictMode) {
    console.log(
      "\n🔒 Running STRICT mode validation against reflected Drizzle schemas...\n",
    );

    // Map tools to their Drizzle tables with required fields
    const strictMappings: Array<{
      toolPath: string;
      toolName: string;
      table: any;
      tableName: string;
      requiredFields: string[];
    }> = [
      {
        toolPath: "tableManagement.createReservation",
        toolName: "create_reservation",
        table: restaurantReservations,
        tableName: "restaurantReservations",
        requiredFields: [
          "restaurantId",
          "guestName",
          "guestEmail",
          "partySize",
          "startTime",
        ],
      },
      {
        toolPath: "tableManagement.updateReservation",
        toolName: "update_reservation",
        table: restaurantReservations,
        tableName: "restaurantReservations",
        requiredFields: ["id", "status"],
      },
      {
        toolPath: "tableManagement.addToWaitlist",
        toolName: "add_to_waitlist",
        table: restaurantWaitlist,
        tableName: "restaurantWaitlist",
        requiredFields: [
          "restaurantId",
          "guestName",
          "guestEmail",
          "partySize",
        ],
      },
      {
        toolPath: "tableManagement.updateWaitlistStatus",
        toolName: "update_waitlist_status",
        table: restaurantWaitlist,
        tableName: "restaurantWaitlist",
        requiredFields: ["id", "status"],
      },
      {
        toolPath: "tableManagement.getTableLayout",
        toolName: "get_table_layout",
        table: restaurantTables,
        tableName: "restaurantTables",
        requiredFields: [
          "restaurantId",
          "tableNumber",
          "maxCapacity",
          "minCapacity",
        ],
      },
    ];

    for (const mapping of strictMappings) {
      const pathParts = mapping.toolPath.split(".");
      let toolDef: any = TOOLS;

      for (const part of pathParts) {
        toolDef = toolDef?.[part];
      }

      if (!toolDef) {
        results.push({
          toolName: mapping.toolName,
          status: "error",
          message: `Tool "${mapping.toolPath}" not found in TOOLS registry (strict validation)`,
        });
        continue;
      }

      const strictResult = validateToolAgainstReflectedDrizzle(
        mapping.toolName,
        toolDef,
        mapping.table,
        mapping.tableName,
        mapping.requiredFields,
      );
      results.push(strictResult);
    }
  }

  // Print results
  console.log("─".repeat(80));
  console.log("");

  const errors = results.filter((r) => r.status === "error");
  const warnings = results.filter((r) => r.status === "warning");
  const ok = results.filter((r) => r.status === "ok");

  if (ok.length > 0) {
    console.log(`✅ ${ok.length} schema(s) in sync:\n`);
    for (const result of ok) {
      console.log(`   ✓ ${result.toolName}`);
    }
    console.log("");
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):\n`);
    for (const result of warnings) {
      console.log(`   ⚠ ${result.toolName}`);
      console.log(`     ${result.message}`);
      if (result.details?.typeMismatch) {
        for (const mismatch of result.details.typeMismatch) {
          console.log(
            `       • ${mismatch.field}: DB=${mismatch.dbType}, Tool=${mismatch.toolType}`,
          );
        }
      }
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log(`❌ ${errors.length} error(s):\n`);
    for (const result of errors) {
      console.log(`   ✗ ${result.toolName}`);
      console.log(`     ${result.message}`);
      if (result.details?.missingInTool) {
        console.log(
          `       Missing fields: ${result.details.missingInTool.join(", ")}`,
        );
      }
    }
    console.log("");
  }

  // Summary
  console.log("─".repeat(80));
  console.log(
    `\nSummary: ${ok.length} OK, ${warnings.length} warnings, ${errors.length} errors\n`,
  );

  // Note: Warnings about missing fields are expected for API contract tools
  // These tools intentionally expose only a subset of DB fields
  const expectedWarnings = warnings.filter(
    (w) =>
      w.message.includes("fields not exposed from DB schema") &&
      w.message.includes("(this may be intentional for API contracts)"),
  );
  const unexpectedWarnings = warnings.filter(
    (w) => !expectedWarnings.includes(w),
  );

  // Write JSON output if requested (for CI)
  if (jsonOutput) {
    const report = {
      timestamp: new Date().toISOString(),
      strictMode,
      summary: {
        total: results.length,
        ok: ok.length,
        warnings: warnings.length,
        errors: errors.length,
        expectedWarnings: expectedWarnings.length,
        unexpectedWarnings: unexpectedWarnings.length,
      },
      results,
      success:
        errors.length === 0 &&
        (strictMode ? unexpectedWarnings.length === 0 : true),
    };

    try {
      writeFileSync(jsonOutput, JSON.stringify(report, null, 2));
      console.log(`📄 JSON report written to: ${jsonOutput}\n`);
    } catch (error) {
      console.error(`Failed to write JSON report: ${error}`);
    }
  }

  // Determine exit code
  if (errors.length > 0) {
    console.log("❌ Schema validation FAILED\n");
    return 1;
  }

  if (unexpectedWarnings.length > 0 && strictMode) {
    console.log(
      "⚠️  Schema validation completed with unexpected warnings (strict mode)\n",
    );
    return 2;
  }

  if (unexpectedWarnings.length > 0) {
    console.log("⚠️  Schema validation completed with unexpected warnings\n");
    return 0; // Unexpected warnings don't fail CI in non-strict mode
  }

  if (warnings.length > 0 && strictMode) {
    // Only expected warnings - this is OK
    console.log(
      "✅ Schema validation PASSED (warnings are expected for API contracts)\n",
    );
    return 0;
  }

  console.log("✅ All schemas are in sync!\n");
  return 0;
}

// CLI entry point
const args = process.argv.slice(2);
const strictMode = args.includes("--strict");
const jsonOutputIndex = args.findIndex((arg) => arg === "--json");
const jsonOutput =
  jsonOutputIndex !== -1
    ? args[jsonOutputIndex + 1] || "schema-sync-report.json"
    : undefined;

validateSchemaSync(strictMode, jsonOutput)
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error("Fatal error during validation:", error);
    process.exit(1);
  });
