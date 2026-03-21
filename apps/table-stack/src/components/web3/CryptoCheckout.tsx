"use client";

import { useState, useEffect } from "react";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useBalance } from "wagmi";
import { parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { Loader2, CheckCircle, AlertCircle, ArrowRight, Coins, Shield, DollarSign } from "lucide-react";
import { useWeb3 } from "./Web3Provider";

interface CryptoCheckoutProps {
  reservationId: string;
  depositAmount: number; // in USD
  restaurantWalletAddress: string;
  guestName: string;
  onCheckoutComplete: (result: { success: boolean; txHash?: string }) => void;
  onError: (error: string) => void;
  onCancel: () => void;
}

/**
 * CryptoCheckout Component for Restaurant Reservations
 *
 * Web3-native checkout flow for reservation deposits:
 * 1. Display deposit amount in USD and crypto
 * 2. Send transaction directly to restaurant wallet
 * 3. Wait for confirmation
 * 4. Call backend to verify and confirm reservation
 */
export function CryptoCheckout({
  reservationId,
  depositAmount,
  restaurantWalletAddress,
  guestName,
  onCheckoutComplete,
  onError,
  onCancel,
}: CryptoCheckoutProps) {
  const { address, chain } = useAccount();
  const { defaultChainId } = useWeb3();
  const { data: balance } = useBalance({
    address,
    chainId: chain?.id || defaultChainId,
  });

  // Convert USD to ETH (assuming 1 ETH = ~$2500 for display, actual rate from oracle)
  // In production, use a price oracle or API
  const ethPriceUsd = 2500; // Placeholder
  const depositEth = depositAmount / ethPriceUsd;
  const depositWei = parseUnits(depositEth.toFixed(18), 18);

  // Transaction state
  const [step, setStep] = useState<"review" | "sending" | "confirming" | "completed" | "error">("review");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Send transaction hook
  const {
    data: hash,
    sendTransaction,
    error: sendError,
  } = useSendTransaction();

  // Wait for transaction receipt
  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    data: receipt,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    confirmations: 1, // 1 confirmation for reservations
    timeout: 120000, // 2 minute timeout
  });

  // Handle send transaction
  useEffect(() => {
    if (step === "sending" && address && restaurantWalletAddress) {
      try {
        sendTransaction({
          to: restaurantWalletAddress as Address,
          value: depositWei,
          chainId: defaultChainId,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Failed to send transaction";
        setErrorMessage(errorMsg);
        setStep("error");
      }
    }
  }, [step, address, restaurantWalletAddress, depositWei, sendTransaction, defaultChainId]);

  // Handle confirmation and backend verification
  useEffect(() => {
    if (isConfirmed && receipt) {
      setStep("confirming");
      setIsVerifying(true);

      // Call backend to verify transaction
      fetch("/api/v1/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: receipt.transactionHash,
          reservationId,
          expectedAmount: depositWei.toString(),
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          setIsVerifying(false);
          if (data.success) {
            setStep("completed");
            onCheckoutComplete({ success: true, txHash: receipt.transactionHash });
          } else {
            setErrorMessage(data.message || "Verification failed");
            setStep("error");
          }
        })
        .catch((err) => {
          setIsVerifying(false);
          setErrorMessage(err.message || "Network error");
          setStep("error");
        });
    }
  }, [isConfirmed, receipt, reservationId, depositWei, onCheckoutComplete]);

  // Handle errors
  useEffect(() => {
    if (sendError || receiptError) {
      const error = sendError || receiptError;
      setErrorMessage(error?.message || "Transaction failed");
      setStep("error");
      onError(error?.message || "Transaction failed");
    }
  }, [sendError, receiptError, onError]);

  // Check if user has sufficient balance
  const hasSufficientBalance = balance && (() => {
    const { formatUnits } = require("viem");
    const balanceEth = parseFloat(formatUnits(balance.value, balance.decimals));
    return balanceEth >= depositEth;
  })();

  const handlePay = () => {
    if (!hasSufficientBalance) {
      setErrorMessage("Insufficient balance for this transaction");
      setStep("error");
      return;
    }
    setStep("sending");
  };

  return (
    <div className="bg-white rounded-2xl border-2 border-blue-100 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Reservation Deposit
          </h3>
          {step === "completed" && (
            <span className="flex items-center gap-1 text-xs bg-white/20 px-2 py-1 rounded-full text-white">
              <CheckCircle className="h-3 w-3" /> Confirmed
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-6 space-y-4">
        {/* Guest Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-900">Reservation for</p>
          <p className="text-lg font-bold text-blue-900">{guestName}</p>
        </div>

        {/* Deposit Summary */}
        <div className="bg-gray-50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Deposit Amount</span>
            <div className="text-right">
              <p className="text-xl font-black text-blue-600">${depositAmount.toFixed(2)}</p>
              <p className="text-xs text-gray-400">≈ {depositEth.toFixed(6)} ETH</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 pt-2">
            This deposit is sent directly to the restaurant's wallet and will be deducted from your final bill.
          </p>
        </div>

        {/* Payment Method Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Secure On-Chain Payment</p>
              <p className="text-xs text-gray-600 mt-1">
                Your payment is verified on the blockchain. Funds are transferred directly to the restaurant's wallet.
              </p>
            </div>
          </div>
        </div>

        {/* Balance Check */}
        {balance && (
          <div className={`flex justify-between items-center text-sm p-3 rounded-lg ${
            hasSufficientBalance ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            <span className="flex items-center gap-2">
              {hasSufficientBalance ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              Wallet Balance
            </span>
            <span className="font-semibold">
              {(() => {
                const { formatUnits } = require("viem");
                return parseFloat(formatUnits(balance.value, balance.decimals)).toFixed(4);
              })()} {balance.symbol}
            </span>
          </div>
        )}

        {/* Error State */}
        {step === "error" && errorMessage && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Payment Failed</p>
              <p className="text-xs mt-1">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {step === "review" && (
          <>
            <button
              onClick={handlePay}
              disabled={!hasSufficientBalance || !address}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 rounded-lg font-bold hover:from-blue-700 hover:to-indigo-700 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl"
            >
              <DollarSign className="h-5 w-5" />
              Pay Deposit
              <ArrowRight className="h-5 w-5" />
            </button>
            <button
              onClick={onCancel}
              className="w-full text-gray-500 text-sm py-2 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          </>
        )}

        {step === "sending" && (
          <button
            disabled
            className="w-full bg-gray-100 text-gray-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2"
          >
            <Loader2 className="animate-spin h-5 w-5" />
            Sending Transaction...
          </button>
        )}

        {step === "confirming" && (
          <button
            disabled
            className="w-full bg-blue-50 text-blue-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2 border border-blue-200"
          >
            <Loader2 className="animate-spin h-5 w-5" />
            {isVerifying ? "Verifying on Blockchain..." : "Waiting for Confirmation..."}
          </button>
        )}

        {step === "completed" && (
          <button
            disabled
            className="w-full bg-green-50 text-green-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2 border border-green-200"
          >
            <CheckCircle className="h-5 w-5" />
            Reservation Confirmed!
          </button>
        )}
      </div>
    </div>
  );
}
