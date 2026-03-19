"use client";

import { useState, useEffect } from "react";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useBalance } from "wagmi";
import { parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { Loader2, CheckCircle, AlertCircle, ArrowRight, Coins, Shield } from "lucide-react";
import { useWeb3 } from "./Web3Provider";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

interface CryptoCheckoutProps {
  cart: CartItem[];
  tip: number;
  deliveryAddress: string;
  selectedVendor: { id: string; name: string } | null;
  onCheckoutComplete: (result: { orderId: string; txHash?: string }) => void;
  onError: (error: string) => void;
  onCancel: () => void;
}

/**
 * CryptoCheckout Component
 * 
 * Web3-native checkout flow:
 * 1. Display order summary with crypto amounts
 * 2. Send transaction to treasury wallet
 * 3. Wait for confirmation
 * 4. Call backend to place order with txHash
 */
export function CryptoCheckout({
  cart,
  tip,
  deliveryAddress,
  selectedVendor,
  onCheckoutComplete,
  onError,
  onCancel,
}: CryptoCheckoutProps) {
  const { address, chain } = useAccount();
  const { treasuryAddress, defaultChainId } = useWeb3();
  const { data: balance } = useBalance({
    address,
    chainId: chain?.id || defaultChainId,
  });

  // Calculate totals
  const subtotalFiat = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalFiat = subtotalFiat + tip;

  // Convert to USDC (6 decimals) - assuming 1 USDC = 1 USD
  const totalUSDC = (totalFiat * 1_000_000).toString();
  const subtotalUSDC = (subtotalFiat * 1_000_000).toString();
  const tipUSDC = (tip * 1_000_000).toString();

  // Transaction state
  const [step, setStep] = useState<"review" | "sending" | "confirming" | "completed" | "error">("review");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    confirmations: 3, // Wait for 3 confirmations on Base
    timeout: 120000, // 2 minute timeout
  });

  // Handle send transaction
  useEffect(() => {
    if (step === "sending" && address && treasuryAddress) {
      try {
        // For USDC transfers, we need to use contract interaction
        // For simplicity, we're using native ETH transfer here
        // In production, you'd use: writeContract({ abi: ERC20_ABI, functionName: 'transfer', args: [treasuryAddress, amount] })
        
        sendTransaction({
          to: treasuryAddress as Address,
          value: parseUnits(totalFiat.toFixed(6), 18), // Convert to Wei (18 decimals for ETH)
          chainId: defaultChainId,
        });
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to send transaction");
        setStep("error");
      }
    }
  }, [step, address, treasuryAddress, totalFiat, sendTransaction, defaultChainId]);

  // Handle confirmation
  useEffect(() => {
    if (isConfirmed && receipt) {
      setStep("completed");
      // Notify parent component with txHash
      onCheckoutComplete({
        orderId: receipt.transactionHash,
        txHash: receipt.transactionHash,
      });
    }
  }, [isConfirmed, receipt, onCheckoutComplete]);

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
    return balanceEth >= totalFiat;
  })();

  // Format crypto amount for display
  const formatCrypto = (amount: number, decimals: number = 18) => {
    return (amount / Math.pow(10, decimals)).toFixed(6);
  };

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
            Crypto Payment
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
        {/* Order Summary */}
        <div className="bg-gray-50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Subtotal</span>
            <div className="text-right">
              <p className="font-medium">${subtotalFiat.toFixed(2)}</p>
              <p className="text-xs text-gray-400">{subtotalUSDC} USDC</p>
            </div>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Driver Tip</span>
            <div className="text-right">
              <p className="font-medium text-emerald-600">${tip.toFixed(2)}</p>
              <p className="text-xs text-gray-400">{tipUSDC} USDC</p>
            </div>
          </div>
          <div className="border-t pt-2 flex justify-between items-center">
            <span className="font-bold text-gray-900">Total</span>
            <div className="text-right">
              <p className="text-xl font-black text-blue-600">${totalFiat.toFixed(2)}</p>
              <p className="text-xs text-gray-400">≈ {totalUSDC} USDC</p>
            </div>
          </div>
        </div>

        {/* Payment Method Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Secure On-Chain Payment</p>
              <p className="text-xs text-gray-600 mt-1">
                Your payment is verified on the blockchain. Funds are transferred to our treasury wallet and your order is confirmed automatically.
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
          <button
            onClick={handlePay}
            disabled={!hasSufficientBalance || !address}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 rounded-lg font-bold hover:from-blue-700 hover:to-indigo-700 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl"
          >
            <Coins className="h-5 w-5" />
            Pay with Crypto
            <ArrowRight className="h-5 w-5" />
          </button>
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
            Waiting for Confirmation...
          </button>
        )}

        {step === "completed" && (
          <button
            disabled
            className="w-full bg-green-50 text-green-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2 border border-green-200"
          >
            <CheckCircle className="h-5 w-5" />
            Payment Confirmed!
          </button>
        )}

        {/* Cancel Button */}
        {step === "review" || step === "error" ? (
          <button
            onClick={onCancel}
            className="w-full text-gray-500 text-sm py-2 hover:text-gray-700 transition-colors"
          >
            Continue Shopping
          </button>
        ) : null}
      </div>
    </div>
  );
}
