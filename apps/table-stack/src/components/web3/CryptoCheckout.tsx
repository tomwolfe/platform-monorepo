"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useBalance,
  useWriteContract,
  useReadContract,
  useSignTypedData,
} from "wagmi";
import {
  parseUnits,
  stringToHex,
  type Address,
  formatUnits,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Coins,
  Shield,
  DollarSign,
} from "lucide-react";
import { useWeb3 } from "./Web3Provider";
import { ERC20_ABI } from "@repo/shared/utils/erc20-abi";

interface CryptoCheckoutProps {
  reservationId: string;
  depositAmount: number; // in USD
  restaurantWalletAddress: string;
  guestName: string;
  onCheckoutComplete: (result: {
    success: boolean;
    txHash?: string;
    signature?: `0x${string}`;
  }) => void;
  onError: (error: string) => void;
  onCancel: () => void;
  /** Enable redirect to pending verification page when backend takes > 5s */
  enablePendingFlow?: boolean;
}

// EIP-712 Domain and Types for typed data signing
const EIP712_DOMAIN = {
  name: "TableStack",
  version: "1",
  chainId: 8453, // Base mainnet
} as const;

const TYPES = {
  Reservation: [
    { name: "reservationId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * CryptoCheckout Component for Restaurant Reservations
 *
 * Web3-native checkout flow with CRITICAL SECURITY FIXES:
 * 1. Real USDC transfers via ERC20 contract
 * 2. Dynamic ETH pricing from CoinGecko (not hardcoded)
 * 3. Reservation ID bound to transaction data (prevents spoofing)
 */
export function CryptoCheckout({
  reservationId,
  depositAmount,
  restaurantWalletAddress,
  guestName,
  onCheckoutComplete,
  onError,
  onCancel,
  enablePendingFlow = true,
}: CryptoCheckoutProps) {
  const { address, chain } = useAccount();
  const { defaultChainId, usdcContractAddress } = useWeb3();
  const router = useRouter();

  // CRITICAL: EIP-712 typed data signing for front-running prevention
  const {
    signTypedData,
    data: signature,
    error: signatureError,
    isPending: isSigning,
  } = useSignTypedData();

  // Calculate deadline (15 minutes from now in seconds)
  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;

  const { data: balance } = useBalance({
    address,
    chainId: chain?.id || defaultChainId,
  });

  // State for payment currency and dynamic pricing
  const [paymentCurrency, setPaymentCurrency] = useState<"USDC" | "ETH">(
    "USDC",
  );
  const [ethPrice, setEthPrice] = useState<number | null>(null); // null until fetched; fail-closed
  const [step, setStep] = useState<
    "review" | "signing" | "sending" | "confirming" | "completed" | "error"
  >("review");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [redirectedToPending, setRedirectedToPending] = useState(false);
  const verificationTimerRef = useRef<NodeJS.Timeout | null>(null);

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
        setEthPrice(null);
      }
    }
    fetchEthPrice();
  }, []);

  // Calculate ETH amount (correctly converted from USD)
  const depositEth =
    paymentCurrency === "ETH" && ethPrice !== null
      ? depositAmount / ethPrice
      : 0;
  const depositWei =
    paymentCurrency === "ETH" && ethPrice !== null
      ? parseUnits(depositEth.toFixed(18), 18)
      : BigInt(0);

  // Convert to USDC (6 decimals)
  const depositUSDC =
    paymentCurrency === "USDC"
      ? parseUnits(depositAmount.toFixed(6), 6)
      : BigInt(0);

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
    confirmations: 1, // 1 confirmation for reservations
    timeout: 120000, // 2 minute timeout
  });

  // Handle send transaction
  useEffect(() => {
    if (step === "sending" && address && restaurantWalletAddress) {
      try {
        if (paymentCurrency === "USDC") {
          // Real USDC transfer via ERC20 contract
          if (!usdcContractAddress) {
            throw new Error("USDC contract address not configured");
          }

          writeContract({
            address: usdcContractAddress as Address,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [restaurantWalletAddress as Address, depositUSDC],
            chainId: defaultChainId,
          });
        } else {
          // CRITICAL FIX: Bind reservation ID to transaction data (prevents spoofing)
          const txData = stringToHex(reservationId);

          sendTransaction({
            to: restaurantWalletAddress as Address,
            value: depositWei,
            data: txData, // Reservation ID embedded in transaction
            chainId: defaultChainId,
          });
        }
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Failed to send transaction";
        setErrorMessage(errorMsg);
        setStep("error");
      }
    }
  }, [
    step,
    address,
    restaurantWalletAddress,
    depositWei,
    depositUSDC,
    paymentCurrency,
    usdcContractAddress,
    sendTransaction,
    writeContract,
    defaultChainId,
    reservationId,
  ]);

  // Handle confirmation and backend verification
  useEffect(() => {
    if (isConfirmed && receipt) {
      setStep("confirming");
      setIsVerifying(true);

      // PHASE 2.1: Set timeout to redirect to pending page after 5 seconds
      // This prevents user panic when backend verification takes longer than expected
      if (enablePendingFlow && !redirectedToPending) {
        verificationTimerRef.current = setTimeout(() => {
          // Only redirect if still in confirming state (i.e., verification hasn't completed yet)
          setRedirectedToPending(true);
          router.push(`/checkout/pending/${reservationId}`);
        }, 5000);
      }

      // Calculate expected amount based on currency
      const expectedAmount =
        paymentCurrency === "USDC"
          ? depositUSDC.toString()
          : depositWei.toString();

      // Call backend to verify transaction - include signature for verification
      fetch("/api/v1/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: receipt.transactionHash,
          reservationId,
          expectedAmount,
          paymentCurrency,
          signature: signature, // CRITICAL: Pass signature for backend verification
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          // Clear the pending redirect timeout
          if (verificationTimerRef.current) {
            clearTimeout(verificationTimerRef.current);
            verificationTimerRef.current = null;
          }

          setIsVerifying(false);
          if (data.success) {
            setStep("completed");
            onCheckoutComplete({
              success: true,
              txHash: receipt.transactionHash,
              signature,
            });
          } else {
            setErrorMessage(data.message || "Verification failed");
            setStep("error");
          }
        })
        .catch((err) => {
          // Clear the pending redirect timeout
          if (verificationTimerRef.current) {
            clearTimeout(verificationTimerRef.current);
            verificationTimerRef.current = null;
          }

          setIsVerifying(false);
          setErrorMessage(err.message || "Network error");
          setStep("error");
        });
    }

    // Cleanup timeout on unmount or dependency change
    return () => {
      if (verificationTimerRef.current) {
        clearTimeout(verificationTimerRef.current);
        verificationTimerRef.current = null;
      }
    };
  }, [
    isConfirmed,
    receipt,
    reservationId,
    depositWei,
    depositUSDC,
    paymentCurrency,
    onCheckoutComplete,
    signature,
    enablePendingFlow,
    redirectedToPending,
    router,
  ]);

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
      return usdcBalance >= depositUSDC;
    } else {
      // Fail-closed: if ethPrice is null, cannot determine balance
      if (ethPrice === null) return false;
      const balanceEth = parseFloat(
        formatUnits(balance.value, balance.decimals),
      );
      return balanceEth >= depositEth;
    }
  })();

  // CRITICAL: Handle signature and transaction flow
  const handlePay = () => {
    if (!hasSufficientBalance) {
      setErrorMessage(
        `Insufficient ${paymentCurrency} balance for this transaction`,
      );
      setStep("error");
      return;
    }
    // First step: Request EIP-712 typed data signature (proves wallet ownership + binds reservation data)
    setStep("signing");

    // Calculate amount in smallest units for signature
    const amountToSign = paymentCurrency === "USDC" ? depositUSDC : depositWei;

    signTypedData({
      domain: EIP712_DOMAIN,
      types: TYPES,
      primaryType: "Reservation",
      message: {
        reservationId,
        amount: amountToSign,
        deadline: BigInt(deadline),
      },
    });
  };

  // CRITICAL: After signature is obtained, proceed to send transaction
  useEffect(() => {
    if (signature && step === "signing") {
      // Signature obtained, now send the transaction
      setStep("sending");
    }
  }, [signature, step]);

  // Handle signature errors
  useEffect(() => {
    if (signatureError) {
      setErrorMessage(`Signature rejected: ${signatureError.message}`);
      setStep("error");
      onError("User rejected signature request");
    }
  }, [signatureError, onError]);

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

        {/* Deposit Summary */}
        <div className="bg-gray-50 rounded-xl p-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Deposit Amount</span>
            <div className="text-right">
              <p className="text-xl font-black text-blue-600">
                ${depositAmount.toFixed(2)}
              </p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC"
                  ? `≈ ${formatUnits(depositUSDC, 6)} USDC`
                  : ethPrice !== null
                    ? `≈ ${depositEth.toFixed(6)} ETH (@ $${ethPrice.toLocaleString()})`
                    : "≈ Price unavailable"}
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-500 pt-2">
            This deposit is sent directly to the restaurant's wallet and will be
            deducted from your final bill.
          </p>
        </div>

        {/* Payment Method Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">
                Secure On-Chain Payment
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Your payment is verified on the blockchain. Your reservation ID
                is cryptographically bound to the transaction to prevent fraud.
              </p>
            </div>
          </div>
        </div>

        {/* Balance Check */}
        {paymentCurrency === "USDC" && usdcBalance ? (
          <div
            className={`flex justify-between items-center text-sm p-3 rounded-lg ${
              hasSufficientBalance
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
          >
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
        ) : (
          balance && (
            <div
              className={`flex justify-between items-center text-sm p-3 rounded-lg ${
                hasSufficientBalance
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-700"
              }`}
            >
              <span className="flex items-center gap-2">
                {hasSufficientBalance ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
                ETH Balance
              </span>
              <span className="font-semibold">
                {parseFloat(
                  formatUnits(balance.value, balance.decimals),
                ).toFixed(4)}{" "}
                {balance.symbol}
              </span>
            </div>
          )
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

        {/* ETH Price Unavailable Warning */}
        {step === "review" &&
          paymentCurrency === "ETH" &&
          ethPrice === null && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Price Unavailable</p>
                <p className="text-xs mt-1">
                  Unable to fetch live ETH price. Please try again or use USDC.
                </p>
              </div>
            </div>
          )}

        {/* Action Buttons */}
        {step === "review" && (
          <>
            <button
              onClick={handlePay}
              disabled={
                !hasSufficientBalance ||
                !address ||
                (paymentCurrency === "ETH" && ethPrice === null)
              }
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 rounded-lg font-bold hover:from-blue-700 hover:to-indigo-700 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl"
            >
              <DollarSign className="h-5 w-5" />
              {paymentCurrency === "ETH" && ethPrice === null
                ? "Price Unavailable"
                : `Pay Deposit with ${paymentCurrency}`}
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

        {step === "signing" && (
          <>
            <button
              disabled
              className="w-full bg-purple-50 text-purple-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2 border border-purple-200"
            >
              <Loader2 className="animate-spin h-5 w-5" />
              {isSigning ? "Signing..." : "Please sign in your wallet"}
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
            {isVerifying
              ? "Verifying on Blockchain..."
              : "Waiting for Confirmation..."}
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
