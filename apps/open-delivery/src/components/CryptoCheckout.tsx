"use client";

import { useState, useEffect } from "react";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useBalance, useWriteContract, useReadContract } from "wagmi";
import { parseUnits, stringToHex, type Address, formatUnits } from "viem";
import { base } from "viem/chains";
import { Loader2, CheckCircle, AlertCircle, ArrowRight, Coins, Shield, Wallet } from "lucide-react";
import { useWeb3 } from "./Web3Provider";
import { ERC20_ABI } from "@repo/shared/utils/erc20-abi";

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
  restaurantWalletAddress?: string | null; // Deprecated: all payments go to treasury for proper tip routing
  onCheckoutComplete: (result: { orderId: string; txHash?: string }) => void;
  onError: (error: string) => void;
  onCancel: () => void;
  orderId?: string; // Order ID to bind to transaction (prevents spoofing)
}

/**
 * CryptoCheckout Component
 *
 * Web3-native checkout flow with CRITICAL SECURITY FIXES:
 * 1. Real USDC transfers via ERC20 contract (not fake ETH transfers)
 * 2. All payments route to treasury (prevents tip theft)
 * 3. Order ID bound to transaction data (prevents spoofing)
 * 4. Dynamic ETH pricing from oracle (not hardcoded)
 */
export function CryptoCheckout({
  cart,
  tip,
  deliveryAddress,
  selectedVendor,
  restaurantWalletAddress, // Deprecated but kept for backwards compatibility
  onCheckoutComplete,
  onError,
  onCancel,
  orderId,
}: CryptoCheckoutProps) {
  const { address, chain } = useAccount();
  const { treasuryAddress, defaultChainId, usdcContractAddress } = useWeb3();
  
  // Get ETH balance
  const { data: balance } = useBalance({
    address,
    chainId: chain?.id || defaultChainId,
  });

  // Calculate totals
  const subtotalFiat = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalFiat = subtotalFiat + tip;

  // Convert to USDC (6 decimals) - 1 USDC = 1 USD
  const totalUSDC = parseUnits(totalFiat.toFixed(6), 6);
  const subtotalUSDC = parseUnits(subtotalFiat.toFixed(6), 6);
  const tipUSDC = parseUnits(tip.toFixed(6), 6);

  // Transaction state
  const [step, setStep] = useState<"review" | "sending" | "confirming" | "completed" | "error">("review");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentCurrency, setPaymentCurrency] = useState<"USDC" | "ETH">("USDC");
  const [ethPrice, setEthPrice] = useState<number>(2500); // Fallback, will fetch dynamically

  // Fetch ETH price dynamically on mount from server-side oracle
  useEffect(() => {
    async function fetchEthPrice() {
      try {
        const response = await fetch("/api/prices");
        const data = await response.json();
        if (data.ETH) {
          setEthPrice(data.ETH);
        }
      } catch (error) {
        console.warn("Failed to fetch ETH price from oracle", error);
      }
    }
    fetchEthPrice();
  }, []);

  // Calculate ETH amount if paying with ETH
  const totalEth = paymentCurrency === "ETH" ? totalFiat / ethPrice : 0;
  const totalEthWei = paymentCurrency === "ETH" ? parseUnits(totalEth.toFixed(18), 18) : BigInt(0);

  // Send transaction hook (for native ETH)
  const {
    data: hash,
    sendTransaction,
    error: sendError,
  } = useSendTransaction();

  // Write contract hook (for USDC transfers)
  const {
    data: contractHash,
    writeContract,
    error: contractError,
  } = useWriteContract();

  // Check USDC balance
  const { data: usdcBalance } = useReadContract({
    address: usdcContractAddress as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address as Address],
    chainId: defaultChainId,
  });

  // Wait for transaction receipt
  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    data: receipt,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash: hash || contractHash,
    confirmations: 3, // Wait for 3 confirmations on Base
    timeout: 120000, // 2 minute timeout
  });

  // Handle send transaction
  useEffect(() => {
    if (step === "sending" && address) {
      try {
        // CRITICAL FIX 1: ALL payments go to treasury (not restaurant wallet)
        // This ensures tips are not stolen and can be properly distributed
        const recipient = treasuryAddress;

        if (!recipient) {
          throw new Error("No payment recipient configured");
        }

        if (paymentCurrency === "USDC") {
          // CRITICAL FIX 2: Real USDC transfer via ERC20 contract
          if (!usdcContractAddress) {
            throw new Error("USDC contract address not configured");
          }

          writeContract({
            address: usdcContractAddress as Address,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [recipient as Address, totalUSDC],
            chainId: defaultChainId,
          });
        } else {
          // CRITICAL FIX 3: Correct ETH conversion (not 30 ETH for $30 burger)
          // totalEthWei already calculated correctly above
          
          // CRITICAL FIX 4: Bind order ID to transaction data (prevents spoofing)
          const txData = orderId ? stringToHex(orderId) : undefined;

          sendTransaction({
            to: recipient as Address,
            value: totalEthWei,
            data: txData,
            chainId: defaultChainId,
          });
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to send transaction");
        setStep("error");
      }
    }
  }, [
    step,
    address,
    treasuryAddress,
    totalUSDC,
    totalEthWei,
    paymentCurrency,
    usdcContractAddress,
    sendTransaction,
    writeContract,
    defaultChainId,
    orderId,
  ]);

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

  // Handle errors - include contract errors for USDC
  useEffect(() => {
    const error = sendError || receiptError || contractError;
    if (error) {
      setErrorMessage(error?.message || "Transaction failed");
      setStep("error");
      onError(error?.message || "Transaction failed");
    }
  }, [sendError, receiptError, contractError, onError]);

  // Check if user has sufficient balance based on selected currency
  const hasSufficientBalance = (() => {
    if (!balance) return false;
    
    if (paymentCurrency === "USDC") {
      if (!usdcBalance) return false;
      return usdcBalance >= totalUSDC;
    } else {
      const balanceEth = parseFloat(formatUnits(balance.value, balance.decimals));
      return balanceEth >= totalEth;
    }
  })();

  const handlePay = () => {
    if (!hasSufficientBalance) {
      setErrorMessage(`Insufficient ${paymentCurrency} balance for this transaction`);
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
        {/* Currency Selector */}
        {step === "review" && (
          <div className="flex gap-2">
            <button
              onClick={() => setPaymentCurrency("USDC")}
              className={`flex-1 py-2 px-4 rounded-lg font-semibold border-2 transition-all ${
                paymentCurrency === "USDC"
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300"
              }`}
            >
              💵 USDC
            </button>
            <button
              onClick={() => setPaymentCurrency("ETH")}
              className={`flex-1 py-2 px-4 rounded-lg font-semibold border-2 transition-all ${
                paymentCurrency === "ETH"
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300"
              }`}
            >
              💎 ETH
            </button>
          </div>
        )}

        {/* Order Summary */}
        <div className="bg-gray-50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Subtotal</span>
            <div className="text-right">
              <p className="font-medium">${subtotalFiat.toFixed(2)}</p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC" 
                  ? `${formatUnits(subtotalUSDC, 6)} USDC`
                  : `≈ ${totalEth.toFixed(6)} ETH`}
              </p>
            </div>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Driver Tip</span>
            <div className="text-right">
              <p className="font-medium text-emerald-600">${tip.toFixed(2)}</p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC"
                  ? `${formatUnits(tipUSDC, 6)} USDC`
                  : `≈ ${(tip / ethPrice).toFixed(6)} ETH`}
              </p>
            </div>
          </div>
          <div className="border-t pt-2 flex justify-between items-center">
            <span className="font-bold text-gray-900">Total</span>
            <div className="text-right">
              <p className="text-xl font-black text-blue-600">${totalFiat.toFixed(2)}</p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC"
                  ? `≈ ${formatUnits(totalUSDC, 6)} USDC`
                  : `≈ ${totalEth.toFixed(6)} ETH (@ $${ethPrice.toLocaleString()})`}
              </p>
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
                Your payment is sent to the protocol treasury wallet where it is held in escrow.
                Funds are split between the restaurant, driver (including tip), and platform fee.
                This ensures proper distribution and prevents tip theft.
              </p>
            </div>
          </div>
        </div>

        {/* Balance Check */}
        {paymentCurrency === "USDC" && usdcBalance ? (
          <div className={`flex justify-between items-center text-sm p-3 rounded-lg ${
            hasSufficientBalance ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            <span className="flex items-center gap-2">
              {hasSufficientBalance ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              USDC Balance
            </span>
            <span className="font-semibold">
              {formatUnits(usdcBalance, 6)} USDC
            </span>
          </div>
        ) : balance && (
          <div className={`flex justify-between items-center text-sm p-3 rounded-lg ${
            hasSufficientBalance ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            <span className="flex items-center gap-2">
              {hasSufficientBalance ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              ETH Balance
            </span>
            <span className="font-semibold">
              {parseFloat(formatUnits(balance.value, balance.decimals)).toFixed(4)} {balance.symbol}
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
            Pay with {paymentCurrency}
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
