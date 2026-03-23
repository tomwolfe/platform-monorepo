/**
 * Execute Step API Route - Thin Controller Layer
 *
 * Delegates all business logic to StepExecutionService.
 * This route handles:
 * - HTTP request/response handling
 * - QStash webhook signature verification
 * - Request validation
 * - Delegation to StepExecutionService
 *
 * @see Phase 3.1: Route De-bloating & Abstraction
 * @see StepExecutionService for business logic
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyQStashWebhook } from "@repo/shared";
import { StepExecutionService, createStepExecutionService } from "@/lib/engine/step-execution-service";

export const runtime = "nodejs";
export const maxDuration = 8; // Vercel Hobby limit - 8s buffer before 10s hard limit

// ============================================================================
// REQUEST/RESPONSE SCHEMAS
// ============================================================================

const ExecuteStepRequestSchema = z.object({
  executionId: z.string().uuid(),
  startStepIndex: z.number().int().nonnegative().optional(),
});

const ExecuteStepResponseSchema = z.object({
  success: z.boolean(),
  executionId: z.string(),
  stepExecuted: z.string().optional(),
  stepStatus: z.enum(["completed", "failed", "pending", "no_steps_remaining"]).optional(),
  completedSteps: z.number(),
  totalSteps: z.number(),
  isComplete: z.boolean(),
  nextStepTriggered: z.boolean().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

// ============================================================================
// SERVICE INSTANCE
// ============================================================================

const stepExecutionService = createStepExecutionService();

// ============================================================================
// API HANDLER
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    // QSTASH WEBHOOK VERIFICATION
    const headers = request.headers;
    const upstashSignature = headers.get("upstash-signature");
    const upstashKeyId = headers.get("upstash-key-id");
    const isQStashWebhook = upstashSignature !== null;

    const isProduction = process.env.NODE_ENV === "production";
    const hasSigningKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;

    // Parse and validate request body
    const parseBody = async (): Promise<{ executionId: string; startStepIndex: number }> => {
      const rawBody = await request.json();
      const validatedBody = ExecuteStepRequestSchema.safeParse(rawBody);

      if (!validatedBody.success) {
        throw new Error(`Invalid request: ${validatedBody.error.message}`);
      }

      return {
        executionId: validatedBody.data.executionId,
        startStepIndex: validatedBody.data.startStepIndex ?? 0,
      };
    };

    // Handle QStash webhook with signature verification
    if (isQStashWebhook) {
      if (isProduction && hasSigningKey) {
        const rawBody = await request.text();
        const isValid = await verifyQStashWebhook(rawBody, upstashSignature, upstashKeyId);

        if (!isValid) {
          console.warn("[ExecuteStep] QStash webhook signature verification failed");
          return NextResponse.json(
            {
              success: false,
              error: {
                code: "UNAUTHORIZED",
                message: "Invalid QStash signature",
              },
            },
            { status: 401 }
          );
        }

        console.log("[ExecuteStep] QStash webhook verified");
        const { executionId, startStepIndex } = JSON.parse(rawBody);
        const result = await stepExecutionService.execute(executionId, startStepIndex, request);
        return NextResponse.json(ExecuteStepResponseSchema.parse(result));
      }

      // Dev mode or no signing key - skip verification
      console.warn("[ExecuteStep] QStash webhook verification skipped (dev mode or no key)");
      const { executionId, startStepIndex } = await parseBody();
      const result = await stepExecutionService.execute(executionId, startStepIndex, request);
      return NextResponse.json(ExecuteStepResponseSchema.parse(result));
    }

    // Direct API call (no webhook signature)
    if (isProduction && hasSigningKey) {
      console.warn(
        "[ExecuteStep] Direct API call received in production with webhook configured. " +
        "Ensure this is intentional."
      );
    }

    const { executionId, startStepIndex } = await parseBody();
    const result = await stepExecutionService.execute(executionId, startStepIndex, request);
    return NextResponse.json(ExecuteStepResponseSchema.parse(result));
  } catch (error) {
    console.error("[ExecuteStep] Unhandled error:", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}
