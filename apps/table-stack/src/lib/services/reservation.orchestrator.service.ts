/**
 * Reservation Orchestrator Service
 *
 * Coordinates the complete reservation workflow within transaction boundaries:
 * - Restaurant resolution (delegates to ShadowRestaurantService for discovery)
 * - Reservation creation (with retry)
 * - Post-execution notification dispatch (delegates to PostExecutionNotificationService)
 *
 * The orchestrator now focuses solely on managing the transaction boundary and
 * workflow coordination, with side effects delegated to dedicated services.
 *
 * @see Task 2: Standardize reserve controller
 * @see T3: Decompose Orchestrators - Audit Roadmap
 */

import {
  IdempotencyService,
  IDEMPOTENCY_KEY_HEADER as _IDEMPOTENCY_KEY_HEADER,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";
import { ConflictError as _ConflictError } from "@repo/shared/errors";
import type { Result as _Result } from "@repo/shared/errors/result-pattern";
import { reservationService } from "../reservation-service";
import type { CreateReservationResult } from "../reservation-service";
import { shadowRestaurantService } from "./shadow-restaurant";
import { postExecutionNotificationService } from "./post-execution-notifications";
import { TableStackError } from "../error-factory";
import { unwrapResult } from "@repo/shared/errors/result-pattern";

const logger = new Logger({ serviceName: "reservation-orchestrator" });

export interface ReserveRequest {
  restaurantId?: string;
  restaurantName?: string;
  restaurantEmail?: string;
  tableId?: string;
  combinedTableIds?: string[];
  guestName: string;
  guestEmail: string;
  partySize: number;
  startTime: string;
  metadata?: Record<string, unknown>;
}

export interface ReserveContext {
  resourceId?: string;
  isInternal: boolean;
}

export interface ReserveResult {
  message: string;
  bookingId: string;
}

export interface ReserveServiceOverrides {
  createReservation?: typeof reservationService.createReservation;
  getRestaurant?: typeof reservationService.getRestaurant;
}

export class ReservationOrchestratorService {
  private readonly idempotencyService: IdempotencyService;
  private readonly createReservation: typeof reservationService.createReservation;
  private readonly getRestaurant: typeof reservationService.getRestaurant;

  constructor(overrides?: ReserveServiceOverrides) {
    const redis = getRedisClient(ServiceNamespace.TS);
    this.idempotencyService = new IdempotencyService(redis);
    this.createReservation =
      overrides?.createReservation ??
      reservationService.createReservation.bind(reservationService);
    this.getRestaurant =
      overrides?.getRestaurant ??
      reservationService.getRestaurant.bind(reservationService);
  }

  /**
   * Check if request is a duplicate based on idempotency key.
   * Returns the cached response if duplicate, or null if new request.
   */
  async checkIdempotency(
    idempotencyKey: string,
  ): Promise<{ isDuplicate: boolean; cachedResponse?: Response }> {
    const isDuplicate = await this.idempotencyService.isDuplicate(
      idempotencyKey,
      "reserve_api",
    );

    if (!isDuplicate) {
      return { isDuplicate: false };
    }

    const status = await this.idempotencyService.getStatus(
      idempotencyKey,
      "reserve_api",
    );

    if (status === "processing") {
      return {
        isDuplicate: true,
        cachedResponse: new Response(
          JSON.stringify({
            error: "Request still processing, please retry",
          }),
          { status: 409 },
        ),
      };
    }

    // Return cached success response (client should have stored the original)
    return {
      isDuplicate: true,
      cachedResponse: new Response(
        JSON.stringify({ message: "Reservation already processed" }),
        { status: 200, headers: { "x-idempotency-duplicate": "true" } },
      ),
    };
  }

  /**
   * Resolve the target restaurant ID, creating a shadow restaurant if needed.
   * Delegates to ShadowRestaurantService for discovery logic.
   */
  async resolveRestaurant(
    context: ReserveContext,
    discoveryName?: string,
    discoveryEmail?: string,
  ): Promise<{ restaurantId: string; isShadow: boolean }> {
    let targetRestaurantId = context.resourceId;

    // Shadow restaurant discovery flow
    if (
      context.isInternal &&
      !targetRestaurantId &&
      discoveryName &&
      discoveryEmail
    ) {
      const { restaurant } = await shadowRestaurantService.resolve(
        discoveryName,
        discoveryEmail,
      );
      targetRestaurantId = restaurant.id;
    }

    if (!targetRestaurantId) {
      throw TableStackError.identifierMissing("restaurant");
    }

    // Check if the resolved restaurant is a shadow
    const isShadow =
      await shadowRestaurantService.isShadowRestaurant(targetRestaurantId);

    return {
      restaurantId: targetRestaurantId,
      isShadow,
    };
  }

  /**
   * Execute the complete reservation workflow.
   *
   * This includes:
   * 1. Restaurant resolution (including shadow discovery)
   * 2. Reservation creation (with retry for transient failures)
   * 3. Email notification dispatch (via QStash)
   * 4. Cache invalidation dispatch (via QStash)
   * 5. Idempotency key marking
   *
   * Returns the reservation result on success.
   * Throws on failure (caller should handle error responses).
   */
  async executeReservation(
    request: ReserveRequest,
    context: ReserveContext,
    idempotencyKey: string,
    origin: string,
  ): Promise<ReserveResult> {
    const {
      restaurantId,
      restaurantName: discoveryName,
      restaurantEmail: discoveryEmail,
      tableId,
      combinedTableIds,
      guestName,
      guestEmail,
      partySize,
      startTime,
      metadata,
    } = request;

    let dbCommitted = false;

    try {
      // Step 1: Resolve restaurant (with shadow discovery if needed)
      const { restaurantId: targetRestaurantId } = await this.resolveRestaurant(
        context,
        discoveryName,
        discoveryEmail,
      );

      // Step 2: Validate restaurant access
      if (restaurantId && restaurantId !== targetRestaurantId) {
        throw TableStackError.unauthorizedRestaurantAccess(
          restaurantId,
          targetRestaurantId,
        );
      }

      // Step 3: Create reservation (with retry)
      const reservationResult = await this.createReservation({
        restaurantId: targetRestaurantId,
        tableId,
        combinedTableIds,
        guestName,
        guestEmail,
        partySize,
        startTime,
        metadata,
      });
      const result = unwrapResult<CreateReservationResult>(reservationResult);
      dbCommitted = true;

      // Step 4: Fetch restaurant details for notifications
      const restaurantResult = await this.getRestaurant(targetRestaurantId);
      const restaurant =
        unwrapResult<typeof import("@repo/database").restaurants.$inferSelect>(
          restaurantResult,
        );

      // Step 5: Dispatch post-execution notifications (email + cache invalidation)
      // This is async and best-effort - the reservation is already committed
      await postExecutionNotificationService.dispatch({
        reservationId: result.reservation.id,
        guestEmail: result.reservation.guestEmail!,
        guestName: result.reservation.guestName || "",
        restaurantName: restaurant.name || "",
        partySize: result.reservation.partySize!,
        startTime: (result.reservation.startTime as Date).toISOString(),
        verificationToken: result.reservation.verificationToken || "",
        isShadow: result.isShadow,
        ownerEmail: restaurant.ownerEmail || undefined,
        claimToken: restaurant.claimToken || undefined,
        origin,
        restaurantId: targetRestaurantId,
        idempotencyKey,
      });

      // Step 6: Mark idempotency key as processed
      await this.idempotencyService.markProcessed(
        idempotencyKey,
        "reserve_api",
      );

      return {
        message: result.isShadow
          ? "Shadow reservation created. Restaurant has been notified."
          : "Reservation created. Please check your email to verify.",
        bookingId: result.reservation.id,
      };
    } catch (err) {
      // Remove idempotency key on failure to allow retries, but only if DB wasn't committed
      if (!dbCommitted) {
        await this.idempotencyService
          .removeKey(idempotencyKey, "reserve_api")
          .catch((e) => {
            logger.warn("Failed to remove idempotency key on error", {
              error: e instanceof Error ? e.message : String(e),
            });
          });
      }
      throw err;
    }
  }
}

// Export singleton instance
export const reservationOrchestrator = new ReservationOrchestratorService();
