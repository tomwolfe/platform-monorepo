/**
 * Schema Sync Validator
 *
 * CI check that validates TOOLS registry schemas against DB_REFLECTED_SCHEMAS.
 * Ensures database schema changes are reflected in MCP tool definitions.
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

import { z } from 'zod';
import { DB_REFLECTED_SCHEMAS, TOOLS } from '../packages/mcp-protocol/src/index';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { writeFileSync } from 'fs';
import { join } from 'path';

interface ValidationResult {
  toolName: string;
  status: 'ok' | 'warning' | 'error';
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
  if ('unwrap' in schema) {
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
  if (!shape) return 'unknown';
  
  // Handle Zod types
  if (shape instanceof z.ZodString) return 'string';
  if (shape instanceof z.ZodNumber) return 'number';
  if (shape instanceof z.ZodBoolean) return 'boolean';
  if (shape instanceof z.ZodArray) return 'array';
  if (shape instanceof z.ZodObject) return 'object';
  if (shape instanceof z.ZodOptional) return 'optional';
  if (shape instanceof z.ZodNullable) return 'nullable';
  if (shape instanceof z.ZodEnum) return 'enum';
  
  return 'unknown';
}

/**
 * Get JSON schema type string for a field
 */
function getJsonSchemaFieldType(jsonSchema: any, fieldName: string): string {
  if (!jsonSchema || !jsonSchema.properties || !jsonSchema.properties[fieldName]) {
    return 'unknown';
  }
  
  const prop = jsonSchema.properties[fieldName];
  if (prop.type) {
    return Array.isArray(prop.type) ? prop.type.join('|') : prop.type;
  }
  if (prop.anyOf) {
    return 'anyOf';
  }
  if (prop.oneOf) {
    return 'oneOf';
  }
  
  return 'unknown';
}

/**
 * Validate a single tool against its corresponding DB schema
 */
function validateToolAgainstDB(
  toolName: string,
  toolDef: any,
  expectedDbSchemaName: string
): ValidationResult {
  const dbSchema = DB_REFLECTED_SCHEMAS[expectedDbSchemaName as keyof typeof DB_REFLECTED_SCHEMAS];
  
  if (!dbSchema) {
    return {
      toolName,
      status: 'error',
      message: `DB schema "${expectedDbSchemaName}" not found in DB_REFLECTED_SCHEMAS`,
    };
  }
  
  // Extract fields from both schemas
  const dbFields = extractZodFields(dbSchema);
  const toolFields = extractJsonSchemaFields(toolDef.inputSchema);
  
  // Find mismatches
  const missingInTool = dbFields.filter(field => !toolFields.includes(field));
  const missingInDb = toolFields.filter(field => !dbFields.includes(field));
  
  // Check for type mismatches
  const typeMismatches: Array<{ field: string; dbType: string; toolType: string }> = [];
  const dbShape = dbSchema instanceof z.ZodObject ? dbSchema.shape : {};
  
  for (const field of dbFields) {
    if (toolFields.includes(field)) {
      const dbType = getZodFieldType(dbShape[field]);
      const toolType = getJsonSchemaFieldType(toolDef.inputSchema, field);
      
      // Normalize types for comparison
      const normalizedDbType = dbType === 'optional' || dbType === 'nullable' 
        ? 'optional' 
        : dbType;
      const normalizedToolType = toolType.includes('null') || toolType === 'null'
        ? 'optional'
        : toolType;
      
      // Skip if both are optional/nullable
      if (normalizedDbType === 'optional' && normalizedToolType === 'optional') {
        continue;
      }
      
      if (normalizedDbType !== normalizedToolType && normalizedToolType !== 'unknown') {
        typeMismatches.push({
          field,
          dbType: normalizedDbType,
          toolType: normalizedToolType,
        });
      }
    }
  }
  
  // Determine status
  if (missingInTool.length > 0) {
    return {
      toolName,
      status: 'error',
      message: `Tool "${toolName}" is missing ${missingInTool.length} field(s) from DB schema "${expectedDbSchemaName}"`,
      details: {
        dbFields,
        toolFields,
        missingInTool,
        missingInDb: missingInDb.length > 0 ? missingInDb : undefined,
        typeMismatch: typeMismatches.length > 0 ? typeMismatches : undefined,
      },
    };
  }
  
  if (missingInDb.length > 0 || typeMismatches.length > 0) {
    const warnings: string[] = [];
    if (missingInDb.length > 0) {
      warnings.push(`Tool has ${missingInDb.length} field(s) not in DB: ${missingInDb.join(', ')}`);
    }
    if (typeMismatches.length > 0) {
      warnings.push(`${typeMismatches.length} type mismatch(es)`);
    }
    
    return {
      toolName,
      status: 'warning',
      message: `Tool "${toolName}" has potential schema mismatches: ${warnings.join('; ')}`,
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
    status: 'ok',
    message: `Tool "${toolName}" is in sync with DB schema "${expectedDbSchemaName}"`,
    details: { dbFields, toolFields },
  };
}

/**
 * Main validation function
 */
async function validateSchemaSync(
  strictMode: boolean = false,
  jsonOutput?: string
): Promise<number> {
  console.log('🔍 Schema Sync Validator\n');
  console.log('Validating TOOLS registry against DB_REFLECTED_SCHEMAS...\n');

  const results: ValidationResult[] = [];

  // Define expected mappings between tools and DB schemas
  const toolToDbMappings: Array<{ toolPath: string; toolName: string; dbSchema: string }> = [
    { toolPath: 'tableManagement.createReservation', toolName: 'create_reservation', dbSchema: 'createReservation' },
    { toolPath: 'tableManagement.updateReservation', toolName: 'update_reservation', dbSchema: 'updateReservation' },
    { toolPath: 'tableManagement.addToWaitlist', toolName: 'add_to_waitlist', dbSchema: 'addToWaitlist' },
    { toolPath: 'tableManagement.updateWaitlistStatus', toolName: 'update_waitlist_status', dbSchema: 'updateWaitlist' },
    { toolPath: 'tableManagement.createReservation', toolName: 'create_reservation', dbSchema: 'reservations' },
    { toolPath: 'tableManagement.getTableLayout', toolName: 'get_table_layout', dbSchema: 'tables' },
  ];

  // Validate each mapping
  for (const mapping of toolToDbMappings) {
    // Navigate to tool in TOOLS registry
    const pathParts = mapping.toolPath.split('.');
    let toolDef: any = TOOLS;

    for (const part of pathParts) {
      toolDef = toolDef?.[part];
    }

    if (!toolDef) {
      results.push({
        toolName: mapping.toolName,
        status: 'error',
        message: `Tool "${mapping.toolPath}" not found in TOOLS registry`,
      });
      continue;
    }

    const result = validateToolAgainstDB(mapping.toolName, toolDef, mapping.dbSchema);
    results.push(result);
  }

  // Print results
  console.log('─'.repeat(80));
  console.log('');

  const errors = results.filter(r => r.status === 'error');
  const warnings = results.filter(r => r.status === 'warning');
  const ok = results.filter(r => r.status === 'ok');

  if (ok.length > 0) {
    console.log(`✅ ${ok.length} schema(s) in sync:\n`);
    for (const result of ok) {
      console.log(`   ✓ ${result.toolName}`);
    }
    console.log('');
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):\n`);
    for (const result of warnings) {
      console.log(`   ⚠ ${result.toolName}`);
      console.log(`     ${result.message}`);
      if (result.details?.typeMismatch) {
        for (const mismatch of result.details.typeMismatch) {
          console.log(`       • ${mismatch.field}: DB=${mismatch.dbType}, Tool=${mismatch.toolType}`);
        }
      }
    }
    console.log('');
  }

  if (errors.length > 0) {
    console.log(`❌ ${errors.length} error(s):\n`);
    for (const result of errors) {
      console.log(`   ✗ ${result.toolName}`);
      console.log(`     ${result.message}`);
      if (result.details?.missingInTool) {
        console.log(`       Missing fields: ${result.details.missingInTool.join(', ')}`);
      }
    }
    console.log('');
  }

  // Summary
  console.log('─'.repeat(80));
  console.log(`\nSummary: ${ok.length} OK, ${warnings.length} warnings, ${errors.length} errors\n`);

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
      },
      results,
      success: errors.length === 0 && (strictMode ? warnings.length === 0 : true),
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
    console.log('❌ Schema validation FAILED\n');
    return 1;
  }

  if (warnings.length > 0 && strictMode) {
    console.log('⚠️  Schema validation completed with warnings (strict mode)\n');
    return 2;
  }

  if (warnings.length > 0) {
    console.log('⚠️  Schema validation completed with warnings\n');
    return 0; // Warnings don't fail CI in non-strict mode
  }

  console.log('✅ All schemas are in sync!\n');
  return 0;
}

// CLI entry point
const args = process.argv.slice(2);
const strictMode = args.includes('--strict');
const jsonOutputIndex = args.findIndex(arg => arg === '--json');
const jsonOutput = jsonOutputIndex !== -1 ? (args[jsonOutputIndex + 1] || 'schema-sync-report.json') : undefined;

validateSchemaSync(strictMode, jsonOutput)
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('Fatal error during validation:', error);
    process.exit(1);
  });
