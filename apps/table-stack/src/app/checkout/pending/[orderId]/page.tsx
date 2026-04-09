/**
 * Pending Verification Page
 *
 * Displayed when a crypto payment has been submitted on-chain but the backend
 * verification is still in progress. This prevents user panic during long
 * blockchain confirmation times or temporary backend delays.
 *
 * Polls the reservation API every 3 seconds until status becomes "confirmed".
 *
 * Route: /checkout/pending/[orderId]
 *
 * @see Phase 2.1: Pending Verification State UI
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Loader2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { Button } from "@repo/ui-theme/components/ui/button";

// ============================================================================
// TYPES
// ============================================================================

interface ReservationStatus {
  id: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  isVerified: boolean;
  paymentTxHash?: string;
  depositAmount?: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// PENDING VERIFICATION PAGE
// ============================================================================

export default function PendingVerificationPage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params.orderId as string;

  const [reservation, setReservation] = useState<ReservationStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [isStale, setIsStale] = useState(false);

  const MAX_POLL_ATTEMPTS = 40; // ~2 minutes at 3s intervals
  const POLL_INTERVAL = 3000; // 3 seconds

  const fetchStatus = useCallback(async () => {
    if (!orderId) return;

    try {
      const response = await fetch(`/api/v1/reservation/${orderId}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Reservation not found");
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setReservation(data);
      setError(null);
      setPollCount((prev) => prev + 1);

      // Check if reservation is confirmed
      if (data.status === "confirmed" || data.isVerified) {
        // Redirect to success page
        router.push(`/book/success?orderId=${orderId}`);
        return;
      }

      // Check if reservation was cancelled or expired
      if (data.status === "cancelled" || data.status === "expired") {
        setError(
          `Reservation was ${data.status}. Please try again or contact support.`,
        );
        return;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch status";
      setError(message);
      console.error("[PendingVerification] Poll error:", err);
    } finally {
      setLoading(false);
    }
  }, [orderId, router]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling
  useEffect(() => {
    if (
      error?.includes("not found") ||
      error?.includes("cancelled") ||
      error?.includes("expired")
    ) {
      return; // Stop polling on terminal errors
    }

    if (pollCount >= MAX_POLL_ATTEMPTS) {
      setIsStale(true);
      return;
    }

    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchStatus, pollCount, error]);

  const handleRetry = () => {
    setError(null);
    setIsStale(false);
    setPollCount(0);
    fetchStatus();
  };

  const handleViewOnExplorer = () => {
    if (reservation?.paymentTxHash) {
      window.open(
        `https://basescan.org/tx/${reservation.paymentTxHash}`,
        "_blank",
      );
    }
  };

  if (loading && !reservation) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2
            size={48}
            className="animate-spin text-blue-600 mx-auto mb-4"
          />
          <h2 className="text-xl font-bold text-gray-900 mb-2">Loading...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="bg-white/20 rounded-full p-2">
                <Clock className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-white">
                  Payment Detected
                </h1>
                <p className="text-sm text-white/80">
                  Verifying on-chain confirmation
                </p>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {/* Status Message */}
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 mb-3">
                <Loader2 size={32} className="animate-spin text-amber-600" />
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                Verifying Your Payment
              </h2>
              <p className="text-sm text-gray-600">
                Payment detected on-chain. Verifying confirmation...
                <br />
                <span className="text-xs text-gray-500">
                  This may take up to 2 minutes.
                </span>
              </p>
            </div>

            {/* Progress Indicator */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Progress</span>
                <span>
                  {Math.min((pollCount / MAX_POLL_ATTEMPTS) * 100, 100).toFixed(
                    0,
                  )}
                  %
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-amber-500 h-2 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min((pollCount / MAX_POLL_ATTEMPTS) * 100, 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-gray-500 text-center">
                Checking every 3 seconds...
              </p>
            </div>

            {/* Reservation Details */}
            {reservation && (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between py-2 border-b border-gray-100">
                  <span className="text-gray-500">Order ID</span>
                  <span className="font-mono text-gray-900">
                    {orderId.slice(0, 12)}...
                  </span>
                </div>
                {reservation.depositAmount && (
                  <div className="flex justify-between py-2 border-b border-gray-100">
                    <span className="text-gray-500">Deposit Amount</span>
                    <span className="font-semibold text-gray-900">
                      ${reservation.depositAmount.toFixed(2)}
                    </span>
                  </div>
                )}
                {reservation.paymentTxHash && (
                  <button
                    onClick={handleViewOnExplorer}
                    className="flex justify-between py-2 border-b border-gray-100 w-full hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-gray-500">Transaction</span>
                    <span className="font-mono text-blue-600 flex items-center gap-1">
                      {reservation.paymentTxHash.slice(0, 10)}...
                      <ExternalLink size={12} />
                    </span>
                  </button>
                )}
                <div className="flex justify-between py-2">
                  <span className="text-gray-500">Status</span>
                  <span className="capitalize text-amber-600 font-medium">
                    {reservation.status.replace("_", " ")}
                  </span>
                </div>
              </div>
            )}

            {/* Error State */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    size={18}
                    className="text-red-500 mt-0.5 flex-shrink-0"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-red-800 mb-1">
                      {isStale
                        ? "Verification Timed Out"
                        : "Verification Issue"}
                    </p>
                    <p className="text-xs text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="space-y-2">
              {(error || isStale) && (
                <Button
                  onClick={handleRetry}
                  className="w-full"
                  variant="outline"
                >
                  <RefreshCw size={16} className="mr-2" />
                  Retry Verification
                </Button>
              )}
              <Button
                onClick={() => router.push("/")}
                variant="ghost"
                className="w-full text-gray-500"
              >
                Return to Home
              </Button>
            </div>
          </div>
        </div>

        {/* Help Text */}
        <p className="text-xs text-gray-500 text-center mt-4">
          Your payment is secure. Blockchain confirmations can take time.
          <br />
          If this page doesn't update after 2 minutes, contact support with your
          Order ID.
        </p>
      </div>
    </div>
  );
}
