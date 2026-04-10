/**
 * OpenAPI Specification Generator
 *
 * Auto-generates OpenAPI 3.1 specification from Zod schemas
 * used in API route handlers.
 *
 * Usage:
 *   pnpm generate:openapi          # Generate and save to file
 *   pnpm generate:openapi --check  # Validate against committed spec
 *
 * This ensures the OpenAPI spec never drifts from the actual API contracts.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import {
  ReserveRequestSchema,
  ReserveResponseSchema,
  AvailabilityRequestSchema,
  AvailabilityResponseSchema,
  WaitlistRequestSchema,
  WaitlistResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
} from "@repo/shared";

// Import zod-to-openapi or use manual conversion
// Since we may not have the library, we'll do a manual mapping

interface OpenAPIPathItem {
  get?: any;
  post?: any;
  put?: any;
  delete?: any;
  patch?: any;
  summary?: string;
  description?: string;
}

interface OpenAPISpec {
  openapi: string;
  info: any;
  paths: Record<string, OpenAPIPathItem>;
  components: {
    schemas: Record<string, any>;
    securitySchemes: Record<string, any>;
  };
  security: any[];
}

/**
 * Convert Zod schema to OpenAPI schema object
 */
function zodToOpenAPISchema(schema: z.ZodType): any {
  // Simplified conversion - in production, use @asteasolutions/zod-to-openapi
  const shape = (schema as any).shape;
  if (!shape) {
    return { type: "object" };
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType;
    const isOptional = zodType instanceof z.ZodOptional;

    properties[key] = convertZodType(zodType);
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };
}

function convertZodType(zodType: z.ZodType): any {
  if (zodType instanceof z.ZodString) {
    return { type: "string" };
  }
  if (zodType instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (zodType instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (zodType instanceof z.ZodOptional) {
    return convertZodType((zodType as any).unwrap());
  }
  if (zodType instanceof z.ZodNullable) {
    return { ...convertZodType((zodType as any).unwrap()), nullable: true };
  }
  if (zodType instanceof z.ZodArray) {
    return {
      type: "array",
      items: convertZodType((zodType as any).element),
    };
  }
  if (zodType instanceof z.ZodObject) {
    return zodToOpenAPISchema(zodType);
  }
  if (zodType instanceof z.ZodEnum) {
    return { type: "string", enum: zodType.options };
  }
  if (zodType instanceof z.ZodDate) {
    return { type: "string", format: "date-time" };
  }

  return { type: "object" };
}

/**
 * Generate complete OpenAPI specification
 */
function generateOpenAPISpec(): OpenAPISpec {
  return {
    openapi: "3.1.0",
    info: {
      title: "TableStack API",
      description: `
# TableStack API Documentation

Auto-generated from Zod validation schemas.

## Authentication

TableStack supports API key and JWT Bearer token authentication.

## Rate Limiting

Rate limit headers are included in all responses.
`,
      version: "1.0.0",
      contact: {
        name: "TableStack Support",
        email: "support@tablestack.com",
      },
    },
    paths: {
      "/api/v1/reserve": {
        post: {
          summary: "Create a restaurant reservation",
          description:
            "Create a new reservation with idempotency support. Returns immediately and sends confirmation email asynchronously.",
          tags: ["Reservations"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenAPISchema(ReserveRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Reservation created successfully",
              content: {
                "application/json": {
                  schema: zodToOpenAPISchema(ReserveResponseSchema),
                },
              },
            },
            "400": { description: "Validation error" },
            "401": { description: "Unauthorized" },
            "409": { description: "Conflict - table already booked" },
          },
          security: [{ ApiKey: [] }, { BearerAuth: [] }],
        },
      },
      "/api/v1/availability": {
        get: {
          summary: "Check table availability",
          description:
            "Check available tables for a given date/time and party size.",
          tags: ["Reservations"],
          parameters: [
            {
              name: "restaurantId",
              in: "query",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "date",
              in: "query",
              required: true,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "partySize",
              in: "query",
              required: true,
              schema: { type: "integer", minimum: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Available tables and suggested slots",
              content: {
                "application/json": {
                  schema: zodToOpenAPISchema(AvailabilityResponseSchema),
                },
              },
            },
          },
        },
      },
      "/api/v1/checkout": {
        post: {
          summary: "Verify crypto payment",
          description:
            "Verify on-chain transaction for restaurant reservation deposit.",
          tags: ["Web3 Payments"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenAPISchema(CheckoutRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Payment verified successfully",
              content: {
                "application/json": {
                  schema: zodToOpenAPISchema(CheckoutResponseSchema),
                },
              },
            },
            "400": { description: "Validation error" },
            "404": { description: "Reservation not found" },
            "409": { description: "Transaction already processed" },
          },
          security: [{ ApiKey: [] }, { BearerAuth: [] }],
        },
      },
      "/api/v1/waitlist": {
        post: {
          summary: "Join waitlist",
          description: "Add a party to the restaurant waitlist.",
          tags: ["Waitlist"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenAPISchema(WaitlistRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Joined waitlist successfully",
              content: {
                "application/json": {
                  schema: zodToOpenAPISchema(WaitlistResponseSchema),
                },
              },
            },
          },
        },
      },
      "/api/cron/dispatch": {
        post: {
          summary: "Async task dispatch endpoint",
          description:
            "Processes background tasks dispatched from API routes (emails, cache invalidation, webhooks).",
          tags: ["Infrastructure"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    task: {
                      type: "string",
                      enum: [
                        "send_reservation_email",
                        "invalidate_availability_cache",
                        "send_checkout_webhook",
                      ],
                    },
                    payload: { type: "object" },
                  },
                  required: ["task", "payload"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Task executed successfully" },
            "400": { description: "Invalid request" },
            "409": { description: "Duplicate task (idempotency)" },
          },
          security: [{ QStashWebhook: [] }],
        },
      },
    },
    components: {
      schemas: {
        ReserveRequest: zodToOpenAPISchema(ReserveRequestSchema),
        ReserveResponse: zodToOpenAPISchema(ReserveResponseSchema),
        CheckoutRequest: zodToOpenAPISchema(CheckoutRequestSchema),
        CheckoutResponse: zodToOpenAPISchema(CheckoutResponseSchema),
        AvailabilityRequest: zodToOpenAPISchema(AvailabilityRequestSchema),
        AvailabilityResponse: zodToOpenAPISchema(AvailabilityResponseSchema),
        WaitlistRequest: zodToOpenAPISchema(WaitlistRequestSchema),
        WaitlistResponse: zodToOpenAPISchema(WaitlistResponseSchema),
        Error: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: { type: "object" },
              },
            },
            timestamp: { type: "string", format: "date-time" },
            traceId: { type: "string" },
          },
        },
      },
      securitySchemes: {
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "API key for legacy authentication",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT Bearer token for authentication",
        },
        QStashWebhook: {
          type: "http",
          scheme: "bearer",
          description: "QStash webhook signature verification",
        },
      },
    },
    security: [],
  };
}

/**
 * Main execution
 */
async function main() {
  const shouldCheck = process.argv.includes("--check");
  const outputPath = resolve(
    process.cwd(),
    "apps/table-stack/src/app/api/docs/openapi.json",
  );

  console.log("📝 Generating OpenAPI specification...\n");

  try {
    const spec = generateOpenAPISpec();
    const specJson = JSON.stringify(spec, null, 2);

    if (shouldCheck) {
      // Check mode: compare with existing file
      if (!existsSync(outputPath)) {
        console.error("❌ OpenAPI spec file does not exist");
        console.error(`   Expected at: ${outputPath}`);
        console.error("   Run 'pnpm generate:openapi' to create it.\n");
        process.exit(1);
      }

      const existingSpec = readFileSync(outputPath, "utf-8");
      if (existingSpec.trim() === specJson.trim()) {
        console.log("✅ OpenAPI spec is up to date\n");
        process.exit(0);
      } else {
        console.error(
          "❌ OpenAPI spec has drifted from generated specification",
        );
        console.error(
          "   Run 'pnpm generate:openapi' to update the committed spec.\n",
        );
        process.exit(1);
      }
    } else {
      // Generate mode: write file
      writeFileSync(outputPath, specJson, "utf-8");
      console.log("✅ OpenAPI specification generated successfully!");
      console.log(`   Output: ${outputPath}\n`);
      process.exit(0);
    }
  } catch (error) {
    console.error("❌ Failed to generate OpenAPI specification");
    if (error instanceof Error) {
      console.error("   Error:", error.message);
    }
    console.error("");
    process.exit(1);
  }
}

main();
