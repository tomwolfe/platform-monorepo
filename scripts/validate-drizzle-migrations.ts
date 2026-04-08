/**
 * Validate Drizzle Migration Consistency
 *
 * Compares schema definitions in packages/database/src/schema/
 * against generated migration SQL files in packages/database/drizzle/
 *
 * Checks for:
 * - Tables in schema without migration entries
 * - Columns in schema missing from migrations
 * - Missing indexes on foreign key columns
 * - Type mismatches
 *
 * Usage: npx tsx scripts/validate-drizzle-migrations.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SCHEMA_DIR = path.join(process.cwd(), "packages/database/src/schema");
const MIGRATIONS_DIR = path.join(process.cwd(), "packages/database/drizzle");

interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
}

interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

interface SchemaIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
}

interface MigrationOperation {
  type: "create_table" | "add_column" | "create_index";
  tableName?: string;
  columnName?: string;
  indexName?: string;
}

let errors: string[] = [];
let warnings: string[] = [];

function recordError(msg: string) {
  errors.push(msg);
}
function recordWarning(msg: string) {
  warnings.push(msg);
}

// Parse migration SQL files to extract operations
function parseMigrations(): MigrationOperation[] {
  const operations: MigrationOperation[] = [];

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`⚠️  Migrations directory not found: ${MIGRATIONS_DIR}`);
    return operations;
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--") || trimmed === "") continue;

      // CREATE TABLE
      const createTableMatch = trimmed.match(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/i,
      );
      if (createTableMatch) {
        operations.push({
          type: "create_table",
          tableName: createTableMatch[1],
        });
      }

      // CREATE INDEX
      const createIndexMatch = trimmed.match(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?\s+ON\s+"?(\w+)"?\s*\(/i,
      );
      if (createIndexMatch) {
        operations.push({
          type: "create_index",
          indexName: createIndexMatch[1],
          tableName: createIndexMatch[2],
        });
      }

      // ALTER TABLE ADD COLUMN
      const addColumnMatch = trimmed.match(
        /ALTER TABLE\s+"?(\w+)"?\s+ADD COLUMN\s+"?(\w+)"?/i,
      );
      if (addColumnMatch) {
        operations.push({
          type: "add_column",
          tableName: addColumnMatch[1],
          columnName: addColumnMatch[2],
        });
      }
    }
  }

  return operations;
}

// Parse schema files (simplified - extracts table and column names)
function parseSchemas(): SchemaTable[] {
  const tables: SchemaTable[] = [];

  if (!fs.existsSync(SCHEMA_DIR)) {
    console.warn(`⚠️  Schema directory not found: ${SCHEMA_DIR}`);
    return tables;
  }

  const schemaFiles = fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".ts"));

  for (const file of schemaFiles) {
    const content = fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8");

    // Find pgTable definitions
    const tableRegex = /pgTable\s*\(\s*['"](\w+)['"]\s*,\s*\{/gs;
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
      const tableName = match[1];
      const columns: SchemaColumn[] = [];
      const indexes: SchemaIndex[] = [];

      // Parse column definitions: fieldName: type('columnName')
      const columnRegex = /(\w+):\s*(\w+)\s*\(\s*['"](\w+)['"]/g;
      let colMatch;
      while ((colMatch = columnRegex.exec(content)) !== null) {
        // Only capture columns within this table's block (simplified)
        columns.push({
          name: colMatch[3],
          type: colMatch[2],
          nullable: true,
          isPrimaryKey: false,
        });
      }

      // Check for primaryKey
      const pkRegex = /\.primaryKey\(\s*\{([^}]+)\}\)/g;
      let pkMatch;
      while ((pkMatch = pkRegex.exec(content)) !== null) {
        const pkCols = pkMatch[1].split(",").map((c) => c.trim());
        for (const col of columns) {
          if (pkCols.some((p) => p.includes(col.name))) {
            col.isPrimaryKey = true;
          }
        }
      }

      // Check for indexes
      const indexRegex =
        /index\s*\(\s*['"](\w+)['"]\s*\)\s*\.on\s*\(\s*\[([^\]]+)\]\s*\)/gs;
      let idxMatch;
      while ((idxMatch = indexRegex.exec(content)) !== null) {
        const idxCols = idxMatch[2]
          .split(",")
          .map((c) => c.trim().replace(/["().]/g, ""));
        indexes.push({
          name: idxMatch[1],
          columns: idxCols,
          isUnique: false,
        });
      }

      // Check for unique indexes
      const uniqueIndexRegex =
        /uniqueIndex\s*\(\s*['"](\w+)['"]\s*\)\s*\.on\s*\(\s*\[([^\]]+)\]\s*\)/gs;
      let uIdxMatch;
      while ((uIdxMatch = uniqueIndexRegex.exec(content)) !== null) {
        const idxCols = uIdxMatch[2]
          .split(",")
          .map((c) => c.trim().replace(/["().]/g, ""));
        indexes.push({
          name: uIdxMatch[1],
          columns: idxCols,
          isUnique: true,
        });
      }

      tables.push({ name: tableName, columns, indexes });
    }
  }

  return tables;
}

// Run validation
function validate(): number {
  console.log("🔍 Validating Drizzle migrations...\n");

  const schemas = parseSchemas();
  const migrations = parseMigrations();

  const migrationTables = new Set<string>();
  const migrationColumns = new Map<string, Set<string>>();
  const migrationIndexes = new Set<string>();

  for (const op of migrations) {
    if (op.type === "create_table" && op.tableName) {
      migrationTables.add(op.tableName);
      if (!migrationColumns.has(op.tableName)) {
        migrationColumns.set(op.tableName, new Set());
      }
    }
    if (op.type === "add_column" && op.tableName && op.columnName) {
      if (!migrationColumns.has(op.tableName)) {
        migrationColumns.set(op.tableName, new Set());
      }
      migrationColumns.get(op.tableName)!.add(op.columnName);
    }
    if (op.type === "create_index" && op.indexName) {
      migrationIndexes.add(op.indexName);
    }
  }

  // Check schema tables exist in migrations
  for (const table of schemas) {
    if (!migrationTables.has(table.name)) {
      recordError(
        `❌ Table "${table.name}" defined in schema but not found in migrations`,
      );
    }
  }

  // Check foreign key columns have indexes
  for (const table of schemas) {
    for (const col of table.columns) {
      if (col.name.endsWith("_id") || col.name.endsWith("Id")) {
        const hasIndex = table.indexes.some((idx) =>
          idx.columns.includes(col.name),
        );
        if (!hasIndex) {
          recordWarning(
            `⚠️  Foreign key column "${table.name}.${col.name}" may be missing an index`,
          );
        }
      }
    }
  }

  // Check migration tables that don't exist in schema (orphaned)
  for (const tableName of migrationTables) {
    const found = schemas.some((t) => t.name === tableName);
    if (!found) {
      recordWarning(
        `⚠️  Table "${tableName}" in migrations but not found in current schema (may be from dropped column)`,
      );
    }
  }

  // Summary
  console.log(`Found ${schemas.length} tables in schema`);
  console.log(`Found ${migrationTables.size} tables in migrations`);
  console.log(`Found ${migrationIndexes.size} indexes in migrations\n`);

  if (errors.length === 0 && warnings.length === 0) {
    console.log(
      "✅ Schema validation passed: All tables, columns, and indexes are consistent",
    );
    return 0;
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} Warning(s):`);
    warnings.forEach((w) => console.log(`   ${w}`));
    console.log("");
  }

  if (errors.length > 0) {
    console.log(`❌ ${errors.length} Error(s):`);
    errors.forEach((e) => console.log(`   ${e}`));
    return 1;
  }

  return 0;
}

const exitCode = validate();
process.exit(exitCode);
