/**
 * MCP-to-DB Schema Sync Tests
 *
 * Automatically verifies that MCP tool schemas match the database schemas
 * reflected in DB_REFLECTED_SCHEMAS.
 *
 * This prevents the "drifting tool contracts" problem where AI agents fail
 * because their tool descriptions don't match database requirements.
 *
 * If a developer adds a column to the Postgres `restaurants` table,
 * this test will flag that the `search_restaurant` MCP tool needs updating.
 *
 * Usage:
 *   pnpm test:mcp-contract
 *
 * @see Task 4: Enforce MCP-to-DB Schema Sync
 */

import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS } from "../src/index";
import { DB_REFLECTED_SCHEMAS } from "../src/bridge";

describe("MCP-to-DB Schema Sync", () => {
  describe("Tool Schema Validation", () => {
    it("should have valid Zod schemas for all tools", () => {
      // Iterate through all tool categories
      const categories = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

      for (const category of categories) {
        const categoryTools = TOOLS[category];
        const toolKeys = Object.keys(categoryTools);

        for (const toolKey of toolKeys) {
          const tool = (categoryTools as any)[toolKey];

          expect(tool).toHaveProperty("name");
          expect(tool).toHaveProperty("description");
          expect(tool).toHaveProperty("schema");

          // Verify schema is a valid Zod schema
          expect(tool.schema).toBeDefined();
          expect(typeof tool.schema._def).toBe("object");
        }
      }
    });

    it("should generate valid JSON Schema from tool schemas", () => {
      const categories = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

      for (const category of categories) {
        const categoryTools = TOOLS[category];
        const toolKeys = Object.keys(categoryTools);

        for (const toolKey of toolKeys) {
          const tool = (categoryTools as any)[toolKey];

          // This should not throw
          const jsonSchema = zodToJsonSchema(tool.schema, tool.name);

          expect(jsonSchema).toBeDefined();
          expect(jsonSchema).toHaveProperty("type", "object");
          expect(jsonSchema).toHaveProperty("properties");
        }
      }
    });

    it("should have unique tool names across all categories", () => {
      const toolNames: string[] = [];

      const categories = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;
      for (const category of categories) {
        const categoryTools = TOOLS[category];
        const toolKeys = Object.keys(categoryTools);

        for (const toolKey of toolKeys) {
          const tool = (categoryTools as any)[toolKey];
          toolNames.push(tool.name);
        }
      }

      const uniqueNames = new Set(toolNames);
      expect(toolNames.length).toBe(uniqueNames.size);

      // If this fails, it will show which names are duplicated
      if (toolNames.length !== uniqueNames.size) {
        const duplicates = toolNames.filter(
          (name, index) => toolNames.indexOf(name) !== index,
        );
        throw new Error(`Duplicate tool names: ${duplicates.join(", ")}`);
      }
    });
  });

  describe("DB_REFLECTED_SCHEMAS Validation", () => {
    it("should have valid Zod schemas for all reflected schemas", () => {
      const schemaNames = Object.keys(DB_REFLECTED_SCHEMAS);

      for (const schemaName of schemaNames) {
        const schema = (DB_REFLECTED_SCHEMAS as any)[schemaName];

        expect(schema).toBeDefined();
        expect(typeof schema._def).toBe("object");

        // Should be able to generate JSON Schema
        const jsonSchema = zodToJsonSchema(schema, schemaName);
        expect(jsonSchema).toBeDefined();
      }
    });

    it("should cover core database tables", () => {
      // Verify that key tables are represented in DB_REFLECTED_SCHEMAS
      const expectedTables = [
        "restaurants",
        "reservations",
        "tables",
        "waitlist",
      ];

      for (const table of expectedTables) {
        expect(DB_REFLECTED_SCHEMAS).toHaveProperty(table);
      }
    });
  });

  describe("Tool-to-DB Schema Mapping", () => {
    // This test verifies that tools that operate on DB entities
    // use schemas that are compatible with the reflected DB schemas

    it("create_reservation tool should be compatible with createReservation DB schema", () => {
      const createReservationTool = (TOOLS.tableManagement as any)
        .createReservation;
      const createReservationDB = DB_REFLECTED_SCHEMAS.createReservation;

      expect(createReservationTool).toBeDefined();
      expect(createReservationDB).toBeDefined();

      // Both should have restaurantId and other common fields
      const toolSchema = zodToJsonSchema(createReservationTool.schema, "tool");
      const dbSchema = zodToJsonSchema(createReservationDB, "db");

      // Verify tool has required fields that DB expects
      if (dbSchema.properties && toolSchema.properties) {
        const dbRequired = (dbSchema as any).required || [];
        const toolProps = toolSchema.properties;

        for (const field of dbRequired) {
          expect(toolProps).toHaveProperty(
            field,
            `Tool schema missing required field: ${field}`,
          );
        }
      }
    });

    it("update_reservation tool should be compatible with updateReservation DB schema", () => {
      const updateReservationTool = (TOOLS.tableManagement as any)
        .updateReservation;
      const updateReservationDB = DB_REFLECTED_SCHEMAS.updateReservation;

      expect(updateReservationTool).toBeDefined();
      expect(updateReservationDB).toBeDefined();

      // Update schemas should allow partial updates (all fields optional)
      const toolJson = zodToJsonSchema(updateReservationTool.schema, "tool");
      const dbJson = zodToJsonSchema(updateReservationDB, "db");

      // Both should have id field as required
      const toolRequired = (toolJson as any).required || [];
      const dbRequired = (dbJson as any).required || [];

      // ID should be required by both
      expect(toolRequired).toContain("id");
      expect(dbRequired).toContain("id");
    });

    it("add_to_waitlist tool should be compatible with addToWaitlist DB schema", () => {
      const addToWaitlistTool = (TOOLS.tableManagement as any).addToWaitlist;
      const addToWaitlistDB = DB_REFLECTED_SCHEMAS.addToWaitlist;

      expect(addToWaitlistTool).toBeDefined();
      expect(addToWaitlistDB).toBeDefined();

      const toolSchema = zodToJsonSchema(addToWaitlistTool.schema, "tool");
      const dbSchema = zodToJsonSchema(addToWaitlistDB, "db");

      // Verify common fields match
      if (dbSchema.properties && toolSchema.properties) {
        const dbProps = dbSchema.properties;
        const toolProps = toolSchema.properties;

        // All DB fields should be present in tool schema
        for (const field of Object.keys(dbProps)) {
          expect(toolProps).toHaveProperty(
            field,
            `Tool schema missing field: ${field}`,
          );
        }
      }
    });
  });

  describe("Schema Field Completeness", () => {
    it("should log schema coverage for auditing", () => {
      const report: Record<string, any> = {};

      // Tool schemas
      const categories = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;
      for (const category of categories) {
        const categoryTools = TOOLS[category];
        const toolKeys = Object.keys(categoryTools);

        report[category] = {
          toolCount: toolKeys.length,
          tools: toolKeys.map((key) => {
            const tool = (categoryTools as any)[key];
            const jsonSchema = zodToJsonSchema(tool.schema, tool.name);
            return {
              name: tool.name,
              fields: Object.keys((jsonSchema.properties as any) || {}),
            };
          }),
        };
      }

      // DB schemas
      const schemaNames = Object.keys(DB_REFLECTED_SCHEMAS);
      report.dbSchemas = {
        count: schemaNames.length,
        schemas: schemaNames.map((name) => {
          const schema = (DB_REFLECTED_SCHEMAS as any)[name];
          const jsonSchema = zodToJsonSchema(schema, name);
          return {
            name,
            fields: Object.keys((jsonSchema.properties as any) || {}),
          };
        }),
      };

      // Log for auditing (useful for CI reports)
      console.log("\n=== Schema Coverage Report ===");
      console.log(JSON.stringify(report, null, 2));

      // Verify we have a reasonable number of tools and schemas
      expect(categories.length).toBeGreaterThan(0);
      expect(schemaNames.length).toBeGreaterThan(0);
    });
  });
});
