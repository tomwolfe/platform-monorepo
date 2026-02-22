/**
 * Drizzle Migration Generator
 *
 * Generates Drizzle ORM migration files from schema change proposals.
 * Integrates with SchemaEvolutionService to auto-generate migrations.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { ProposedSchemaChange, ProposedSchemaChangeSchema } from "./schema-evolution";

// ============================================================================
// SAFE-SQL VALIDATOR
// Prevents SQL injection and reserved keyword violations in schema migrations
// ============================================================================

/**
 * Reserved PostgreSQL keywords that cannot be used as identifiers without quoting
 * This is a conservative list - when in doubt, the validator rejects it
 */
const RESERVED_POSTGRES_KEYWORDS = new Set([
  // Core SQL keywords
  "select", "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "from", "where", "group", "order", "having", "limit", "offset", "join",
  "inner", "outer", "left", "right", "full", "cross", "on", "as",
  "table", "index", "view", "sequence", "schema", "database", "column",
  "primary", "foreign", "key", "references", "constraint", "unique", "check",
  "default", "null", "not", "true", "false", "case", "when", "then", "else",
  "end", "and", "or", "in", "exists", "between", "like", "ilike", "similar",
  "to", "is", "distinct", "all", "any", "some", "cast", "convert",
  "user", "current_user", "session_user", "role", "authorization", "grant",
  "revoke", "execute", "usage", "create", "temporary", "temp",
  "with", "recursive", "values", "returning", "into", "union", "except",
  "intersect", "for", "of", "nowait", "skip", "locked",
  "asc", "desc", "nulls", "first", "last",
  // Additional dangerous keywords
  "password", "admin", "superuser", "login", "role", "permission",
  "function", "procedure", "trigger", "rule", "domain", "type",
  "array", "enum", "composite", "range", "multirange",
]);

/**
 * Safe field name pattern:
 * - Must start with lowercase letter or underscore
 * - Can only contain lowercase letters, numbers, and underscores
 * - Maximum 63 characters (PostgreSQL identifier limit)
 * - Cannot be a reserved keyword
 */
const SAFE_FIELD_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_FIELD_NAME_LENGTH = 63;

/**
 * Validation result for field names
 */
interface FieldNameValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a field name for safety
 * 
 * @param fieldName - The field name to validate
 * @returns Validation result with error message if invalid
 */
function validateFieldName(fieldName: string): FieldNameValidation {
  // Check for empty or null
  if (!fieldName || fieldName.trim().length === 0) {
    return {
      valid: false,
      error: `Field name cannot be empty`,
    };
  }

  // Check length
  if (fieldName.length > MAX_FIELD_NAME_LENGTH) {
    return {
      valid: false,
      error: `Field name "${fieldName}" exceeds maximum length of ${MAX_FIELD_NAME_LENGTH} characters`,
    };
  }

  // Check pattern (lowercase, numbers, underscores only)
  if (!SAFE_FIELD_NAME_PATTERN.test(fieldName)) {
    return {
      valid: false,
      error: `Field name "${fieldName}" contains illegal characters. Must be snake_case (lowercase letters, numbers, underscores only, must start with letter or underscore)`,
    };
  }

  // Check for reserved keywords
  if (RESERVED_POSTGRES_KEYWORDS.has(fieldName.toLowerCase())) {
    return {
      valid: false,
      error: `CRITICAL: Field name "${fieldName}" is a reserved PostgreSQL keyword and cannot be used`,
    };
  }

  return { valid: true };
}

/**
 * Validate SQL string for dangerous patterns
 * 
 * @param sql - SQL string to validate
 * @returns Validation result with error message if dangerous patterns detected
 */
function validateSqlString(sql: string): FieldNameValidation {
  // Check for common SQL injection patterns
  const dangerousPatterns = [
    /--/g,  // SQL comment
    /;/g,   // Statement terminator (injection separator)
    /\bDROP\b/i,
    /\bDELETE\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+USER\b/i,
    /\bCREATE\s+USER\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bEXECUTE\b/i,
    /'/g,   // Quote injection (unless properly escaped)
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(sql)) {
      return {
        valid: false,
        error: `CRITICAL: SQL contains potentially dangerous pattern: ${pattern.source}`,
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// MIGRATION SCHEMAS
// ============================================================================

export const MigrationFileSchema = z.object({
  /** Unique migration ID */
  id: z.string().uuid(),
  /** Migration file name (e.g., "0001_add_user_email.ts") */
  fileName: z.string(),
  /** Full migration file content */
  content: z.string(),
  /** Schema change proposal this migration addresses */
  proposalId: z.string().uuid(),
  /** Target table name */
  tableName: z.string(),
  /** Migration type */
  migrationType: z.enum(["add_columns", "remove_columns", "modify_columns", "create_index", "drop_index"]),
  /** Rollback migration content */
  rollbackContent: z.string().optional(),
  /** Whether migration is safe to run concurrently */
  isConcurrentSafe: z.boolean().default(false),
  /** Estimated migration duration */
  estimatedDurationMs: z.number().optional(),
  /** Metadata */
  createdAt: z.string().datetime(),
});

export type MigrationFile = z.infer<typeof MigrationFileSchema>;

export const MigrationGenerationResultSchema = z.object({
  success: z.boolean(),
  migration: MigrationFileSchema.optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  /** SQL preview for review */
  sqlPreview: z.string().optional(),
  /** Affected columns */
  affectedColumns: z.array(z.object({
    name: z.string(),
    type: z.string(),
    action: z.enum(["add", "remove", "modify"]),
  })).default([]),
});

export type MigrationGenerationResult = z.infer<typeof MigrationGenerationResultSchema>;

// ============================================================================
// COLUMN TYPE MAPPING
// Maps Zod types to Drizzle/PostgreSQL types
// ============================================================================

const TYPE_MAPPING: Record<string, { drizzleType: string; postgresType: string; defaultValue?: string }> = {
  string: { drizzleType: "text()", postgresType: "TEXT" },
  number: { drizzleType: "integer()", postgresType: "INTEGER" },
  boolean: { drizzleType: "boolean()", postgresType: "BOOLEAN", defaultValue: "false" },
  datetime: { drizzleType: "timestamp()", postgresType: "TIMESTAMP" },
  object: { drizzleType: "jsonb()", postgresType: "JSONB" },
  array: { drizzleType: "jsonb()", postgresType: "JSONB" },
};

// ============================================================================
// MIGRATION GENERATOR SERVICE
// ============================================================================

export class MigrationGeneratorService {
  /**
   * Generate a Drizzle migration file from a schema change proposal
   * 
   * SECURITY: Validates all field names against SQL injection and reserved keywords
   * before generating migration SQL.
   */
  async generateMigration(proposal: ProposedSchemaChange): Promise<MigrationGenerationResult> {
    try {
      // Determine table name from tool/intent
      const tableName = this.inferTableName(proposal);

      if (!tableName) {
        return {
          success: false,
          error: `Could not infer table name for ${proposal.intentType}:${proposal.toolName}`,
          warnings: [],
          affectedColumns: [],
        };
      }

      // SECURITY FIX: Validate all field names BEFORE generating migration
      const validationErrors: string[] = [];
      
      for (const field of proposal.proposedFields) {
        const validation = validateFieldName(field.name);
        if (!validation.valid) {
          validationErrors.push(validation.error!);
        }
      }

      // Also validate deprecated fields
      if (proposal.deprecatedFields) {
        for (const fieldName of proposal.deprecatedFields) {
          const validation = validateFieldName(fieldName);
          if (!validation.valid) {
            validationErrors.push(validation.error!);
          }
        }
      }

      // Block migration if any validation fails
      if (validationErrors.length > 0) {
        return {
          success: false,
          error: `CRITICAL: Schema validation failed - ${validationErrors.join("; ")}`,
          warnings: [],
          affectedColumns: [],
        };
      }

      // Generate migration content
      const migrationContent = this.generateMigrationContent(proposal, tableName);
      const rollbackContent = this.generateRollbackContent(proposal, tableName);

      // Generate SQL preview
      const sqlPreview = this.generateSqlPreview(proposal, tableName);

      // SECURITY FIX: Validate generated SQL for dangerous patterns
      const sqlValidation = validateSqlString(sqlPreview);
      if (!sqlValidation.valid) {
        return {
          success: false,
          error: sqlValidation.error,
          warnings: [],
          affectedColumns: [],
        };
      }

      // Create migration file name
      const fileName = this.generateMigrationFileName(proposal, tableName);

      // Determine affected columns
      const affectedColumns: Array<{ name: string; type: string; action: 'add' | 'remove' | 'modify' }> = proposal.proposedFields.map(field => ({
        name: field.name,
        type: TYPE_MAPPING[field.type]?.postgresType || "TEXT",
        action: "add",
      }));

      // Add deprecated columns
      if (proposal.deprecatedFields) {
        affectedColumns.push(
          ...proposal.deprecatedFields.map(fieldName => ({
            name: fieldName,
            type: "UNKNOWN",
            action: "remove" as const,
          }))
        );
      }

      // Check if migration is concurrent-safe
      const isConcurrentSafe = this.isConcurrentSafeMigration(proposal);

      // Estimate duration
      const estimatedDurationMs = this.estimateMigrationDuration(proposal);

      const migration: MigrationFile = {
        id: crypto.randomUUID(),
        fileName,
        content: migrationContent,
        proposalId: proposal.id,
        tableName,
        migrationType: "add_columns",
        rollbackContent,
        isConcurrentSafe,
        estimatedDurationMs,
        createdAt: new Date().toISOString(),
      };

      return {
        success: true,
        migration,
        warnings: this.generateWarnings(proposal, tableName),
        sqlPreview,
        affectedColumns,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Migration generation failed",
        warnings: [],
        affectedColumns: [],
      };
    }
  }

  /**
   * Infer table name from proposal
   */
  private inferTableName(proposal: ProposedSchemaChange): string | null {
    // Map tool names to table names
    const toolToTableMap: Record<string, string> = {
      create_reservation: "restaurant_reservations",
      update_reservation: "restaurant_reservations",
      cancel_reservation: "restaurant_reservations",
      create_restaurant: "restaurants",
      update_restaurant: "restaurants",
      add_to_waitlist: "restaurant_waitlist",
      update_waitlist: "restaurant_waitlist",
      create_table: "restaurant_tables",
      update_table: "restaurant_tables",
      create_product: "restaurant_products",
      update_product: "restaurant_products",
      create_inventory: "inventory_levels",
      update_inventory: "inventory_levels",
      create_guest: "guest_profiles",
      update_guest: "guest_profiles",
    };

    // Check direct tool mapping
    if (proposal.toolName in toolToTableMap) {
      return toolToTableMap[proposal.toolName];
    }

    // Try to infer from intent type
    const intentToTableMap: Record<string, string> = {
      BOOKING: "restaurant_reservations",
      RESERVATION: "restaurant_reservations",
      RESTAURANT: "restaurants",
      WAITLIST: "restaurant_waitlist",
      TABLE: "restaurant_tables",
      PRODUCT: "restaurant_products",
      INVENTORY: "inventory_levels",
      GUEST: "guest_profiles",
    };

    if (proposal.intentType in intentToTableMap) {
      return intentToTableMap[proposal.intentType];
    }

    return null;
  }

  /**
   * Generate migration file content
   */
  private generateMigrationContent(proposal: ProposedSchemaChange, tableName: string): string {
    const timestamp = new Date().toISOString();
    const columns = proposal.proposedFields.map(field => this.generateColumnDefinition(field)).join("\n");
    
    return `/**
 * Migration: ${proposal.reason}
 * Generated: ${timestamp}
 * Proposal ID: ${proposal.id}
 * 
 * Auto-generated by SchemaEvolutionService
 * Review before applying!
 */

import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const ${tableName} = pgTable("${tableName}", {
${columns}
});

export async function up(db: any): Promise<void> {
  // Add new columns
${proposal.proposedFields.map(field => this.generateUpMigrationStatement(tableName, field)).join("\n")}
}

export async function down(db: any): Promise<void> {
  // Rollback: Remove columns
${proposal.proposedFields.map(field => this.generateDownMigrationStatement(tableName, field)).join("\n")}
${proposal.deprecatedFields?.map(field => `  // Note: Field ${field} was already deprecated`).join("\n") || ""}
}
`;
  }

  /**
   * Generate column definition
   */
  private generateColumnDefinition(field: {
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "datetime";
    required: boolean;
    description?: string;
    defaultValue?: unknown;
    validation?: Record<string, unknown>;
  }): string {
    const typeInfo = TYPE_MAPPING[field.type] || TYPE_MAPPING.string;
    const drizzleType = typeInfo.drizzleType;
    
    let definition = `  ${field.name}: ${drizzleType}`;
    
    if (field.required) {
      definition += ".notNull()";
    }
    
    if (field.defaultValue !== undefined) {
      definition += `.default(${JSON.stringify(field.defaultValue)})`;
    }
    
    if (field.description) {
      // Note: Drizzle doesn't support comments inline, would need separate comment migration
    }
    
    definition += ",";
    return definition;
  }

  /**
   * Generate UP migration statement
   */
  private generateUpMigrationStatement(
    tableName: string,
    field: {
      name: string;
      type: "string" | "number" | "boolean" | "object" | "array" | "datetime";
      required: boolean;
      defaultValue?: unknown;
    }
  ): string {
    const typeInfo = TYPE_MAPPING[field.type] || TYPE_MAPPING.string;
    const postgresType = typeInfo.postgresType;

    let statement = `  await db.execute(sql\`ALTER TABLE ${tableName} ADD COLUMN ${field.name} ${postgresType}\`)`;

    if (field.required && field.defaultValue !== undefined) {
      statement = `  await db.execute(sql\`ALTER TABLE ${tableName} ADD COLUMN ${field.name} ${postgresType} DEFAULT ${this.sqlLiteral(field.defaultValue)}\`)`;
    } else if (field.required) {
      // For required fields without default, add with NULL first, then update, then set NOT NULL
      return `  // Add column as nullable first
  await db.execute(sql\`ALTER TABLE ${tableName} ADD COLUMN ${field.name} ${postgresType}\`);
  // TODO: Set default values for existing rows
  // await db.execute(sql\`UPDATE ${tableName} SET ${field.name} = ? WHERE ${field.name} IS NULL\`);
  await db.execute(sql\`ALTER TABLE ${tableName} ALTER COLUMN ${field.name} SET NOT NULL\`);`;
    }

    return statement;
  }

  /**
   * Generate DOWN migration statement
   */
  private generateDownMigrationStatement(
    tableName: string,
    field: { name: string }
  ): string {
    return `  await db.execute(sql\`ALTER TABLE ${tableName} DROP COLUMN ${field.name}\`);`;
  }

  /**
   * Generate rollback content
   */
  private generateRollbackContent(proposal: ProposedSchemaChange, tableName: string): string {
    const timestamp = new Date().toISOString();
    
    return `/**
 * Rollback Migration
 * Generated: ${timestamp}
 */

export async function up(db: any): Promise<void> {
  // Re-add deprecated columns
${proposal.deprecatedFields?.map(field => `  await db.execute(sql\`ALTER TABLE ${tableName} ADD COLUMN ${field} TEXT\`);`).join("\n") || "  // No columns to restore"}
}

export async function down(db: any): Promise<void> {
  // Re-remove proposed columns
${proposal.proposedFields.map(field => `  await db.execute(sql\`ALTER TABLE ${tableName} DROP COLUMN ${field.name}\`);`).join("\n")}
}
`;
  }

  /**
   * Generate SQL preview for review
   */
  private generateSqlPreview(proposal: ProposedSchemaChange, tableName: string): string {
    const statements: string[] = [];
    
    for (const field of proposal.proposedFields) {
      const typeInfo = TYPE_MAPPING[field.type] || TYPE_MAPPING.string;
      let statement = `ALTER TABLE ${tableName} ADD COLUMN ${field.name} ${typeInfo.postgresType}`;
      
      if (field.required && field.defaultValue !== undefined) {
        statement += ` DEFAULT ${this.sqlLiteral(field.defaultValue)}`;
      }
      
      if (field.required) {
        statement += ", ALTER COLUMN SET NOT NULL";
      }
      
      statements.push(statement + ";");
    }
    
    if (proposal.deprecatedFields) {
      for (const field of proposal.deprecatedFields) {
        statements.push(`ALTER TABLE ${tableName} DROP COLUMN ${field};`);
      }
    }
    
    return statements.join("\n");
  }

  /**
   * Generate migration file name
   */
  private generateMigrationFileName(proposal: ProposedSchemaChange, tableName: string): string {
    const timestamp = Date.now();
    const action = proposal.proposedFields.length > 0 ? "add" : "remove";
    const fields = proposal.proposedFields.slice(0, 3).map(f => f.name).join("_");
    
    return `${timestamp}_${action}_${fields}_${tableName}.ts`;
  }

  /**
   * Generate warnings for migration
   */
  private generateWarnings(proposal: ProposedSchemaChange, tableName: string): string[] {
    const warnings: string[] = [];
    
    // Check for required fields without defaults
    const requiredWithoutDefault = proposal.proposedFields.filter(
      f => f.required && f.defaultValue === undefined
    );
    
    if (requiredWithoutDefault.length > 0) {
      warnings.push(
        `Required fields without defaults will require manual data migration: ${requiredWithoutDefault.map(f => f.name).join(", ")}`
      );
    }
    
    // Check for large tables (would need concurrent migration)
    if (!this.isConcurrentSafeMigration(proposal)) {
      warnings.push("This migration will lock the table during execution. Consider running during low-traffic period.");
    }
    
    // Check for many fields
    if (proposal.proposedFields.length > 5) {
      warnings.push(`Adding ${proposal.proposedFields.length} columns at once. Consider splitting into separate migrations.`);
    }
    
    return warnings;
  }

  /**
   * Check if migration is concurrent-safe
   */
  private isConcurrentSafeMigration(proposal: ProposedSchemaChange): boolean {
    // Adding nullable columns is concurrent-safe
    // Adding required columns or modifying existing columns is NOT concurrent-safe
    const hasRequiredFields = proposal.proposedFields.some(f => f.required);
    const hasModifications = proposal.deprecatedFields && proposal.deprecatedFields.length > 0;
    
    return !hasRequiredFields && !hasModifications;
  }

  /**
   * Estimate migration duration
   */
  private estimateMigrationDuration(proposal: ProposedSchemaChange): number {
    // Rough estimate: 100ms per column + 1ms per row
    // This is very approximate and would need actual table stats for accuracy
    const baseTime = 100 * proposal.proposedFields.length;
    const estimatedRows = 10000; // Would need to fetch actual row count
    
    return baseTime + estimatedRows;
  }

  /**
   * Convert value to SQL literal
   */
  private sqlLiteral(value: unknown): string {
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") return value.toString();
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    return JSON.stringify(value);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMigrationGeneratorService(): MigrationGeneratorService {
  return new MigrationGeneratorService();
}
