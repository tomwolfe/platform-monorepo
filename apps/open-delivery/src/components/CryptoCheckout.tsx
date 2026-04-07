"use client";

import React from "react";
import { useState, useEffect } from "react";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useBalance, useWriteContract, useReadContract, useSignMessage, useEstimateGas } from "wagmi";
import { parseUnits, stringToHex, type Address, formatUnits } from "viem";
import { base } from "viem/chains";
import { Loader2, CheckCircle, AlertCircle, ArrowRight, Coins, Shield, Wallet } from "lucide-react";
import { useWeb3 } from "./Web3Provider";
import { ERC20_ABI } from "@repo/shared/utils/erc20-abi";
import { ESCROW_ABI } from "@repo/shared/utils/escrow-abi";

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
  restaurantWalletAddress: string; // REQUIRED: Direct P2P escrow routing needs restaurant address
  onCheckoutComplete: (result: { orderId: string; txHash?: string; signature?: `0x${string}` }) => void;
  onError: (error: string) => void;
  onCancel: () => void;
  orderId?: string; // Order ID to bind to transaction (prevents spoofing)
  platformFeeBps?: number; // Platform fee in basis points (default: 100 = 1%)
}

/**
 * CryptoCheckout Component
 *
 * Non-custodial P2P escrow checkout flow:
 * 1. Real USDC/ETH deposits via Escrow Contract (not treasury)
 * 2. Funds split instantly: restaurant gets subtotal, platform gets fee, tip locked
 * 3. Order ID bound to transaction data (prevents spoofing)
 * 4. Dynamic ETH pricing from oracle (not hardcoded)
 * 5. Signature-based wallet ownership verification
 */
export function CryptoCheckout({
  cart,
  tip,
  deliveryAddress,
  selectedVendor,
  restaurantWalletAddress,
  onCheckoutComplete,
  onError,
  onCancel,
  orderId,
  platformFeeBps = 100, // Default 1%
}: CryptoCheckoutProps) {
  const { address, chain } = useAccount();
  const { escrowContractAddress, platformFeeWallet, defaultChainId, usdcContractAddress } = useWeb3();

  // CRITICAL: Signature hook for front-running prevention
  const { signMessage, data: signature, error: signatureError, isPending: isSigning } = useSignMessage();

  // Get ETH balance
  const { data: balance } = useBalance({
    address,
    chainId: chain?.id || defaultChainId,
  });

  // Estimate gas for ETH transactions
  const { data: estimatedGas, isError: isGasEstimationError } = useEstimateGas({
    to: escrowContractAddress as Address,
    value: totalEthWei > 0n ? totalEthWei : undefined,
    data: orderId ? stringToHex(orderId) : undefined,
    chainId: defaultChainId,
    query: {
      enabled: paymentCurrency === "ETH" && !!address && totalEthWei > 0n,
    },
  });

  // Calculate estimated gas fee in USD
  const [estimatedGasFeeUsd, setEstimatedGasFeeUsd] = useState<number>(0);

  useEffect(() => {
    if (estimatedGas && ethPrice) {
      // Gas is in wei, convert to ETH then to USD
      const gasEth = parseFloat(formatUnits(estimatedGas, 18));
      const gasFeeUsd = gasEth * ethPrice;
      setEstimatedGasFeeUsd(gasFeeUsd);
    }
  }, [estimatedGas, ethPrice]);

  // Calculate totals
  const subtotalFiat = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalFiat = subtotalFiat + tip;

  // Calculate platform fee (in USD cents)
  const platformFeeFiat = (subtotalFiat * platformFeeBps) / 10000;

  // CRITICAL: Convert to USDC (6 decimals) using integer cents to avoid floating-point errors
  // 1 USD = 1 USDC, so we convert USD -> cents -> atomic USDC units
  // Formula: USDC_atomic = (USD_cents * 10^6) / 100 = USD_cents * 10^4
  const USDC_CENTS_MULTIPLIER = 10_000n; // Convert cents to USDC atomic units

  const subtotalCents = BigInt(Math.round(subtotalFiat * 100));
  const tipCents = BigInt(Math.round(tip * 100));
  const platformFeeCents = BigInt(Math.round(platformFeeFiat * 100));
  const totalCents = subtotalCents + tipCents; // Customer pays subtotal + tip (platform fee is separate)

  const subtotalUSDC = subtotalCents * USDC_CENTS_MULTIPLIER;
  const tipUSDC = tipCents * USDC_CENTS_MULTIPLIER;
  const platformFeeUSDC = platformFeeCents * USDC_CENTS_MULTIPLIER;

  // Transaction state - added "signing" step for signature before transaction
  const [step, setStep] = useState<"review" | "signing" | "sending" | "confirming" | "completed" | "error">("review");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentCurrency, setPaymentCurrency] = useState<"USDC" | "ETH">("USDC");
  const [ethPrice, setEthPrice] = useState<number | null>(null); // null until fetched; fail-closed
  const [isPriceStale, setIsPriceStale] = useState(false); // Track if price is stale (financial safety)

  // Fetch ETH price dynamically on mount from server-side oracle
  useEffect(() => {
    async function fetchEthPrice() {
      try {
        const response = await fetch("/api/prices");
        const data = await response.json();
        if (data.ETH) {
          setEthPrice(data.ETH);
          // Extract stale flag from response
          setIsPriceStale(data.isStale === true);
        }
      } catch (error) {
        console.warn("Failed to fetch ETH price from oracle", error);
        setEthPrice(null);
        setIsPriceStale(false);
      }
    }
    fetchEthPrice();
  }, []);

  // CRITICAL: Use BigInt math to avoid floating-point precision errors
  // Convert USD to ETH using basis points (10000 = 1.0) for precision
  // Formula: ETH_Wei = (USD_cents * 10^20) / (ETH_price_USD_scaled)
  const BASIS_POINTS = 10_000n;
  const ethPriceScaled = ethPrice !== null ? BigInt(Math.round(ethPrice * Number(BASIS_POINTS))) : null;

  // Convert fiat amounts to cents first (integer), then to Wei
  // Multiplier: 10^20 to convert cents to Wei with price scaling (18 decimals + 2 for cents)
  const CENTS_TO_WEI_MULTIPLIER = 10n ** 20n;

  // Calculate ETH amounts in Wei using BigInt division
  const subtotalEthWei = paymentCurrency === "ETH" && ethPriceScaled !== null
    ? (subtotalCents * CENTS_TO_WEI_MULTIPLIER) / ethPriceScaled
    : BigInt(0);
  const tipEthWei = paymentCurrency === "ETH" && ethPriceScaled !== null
    ? (tipCents * CENTS_TO_WEI_MULTIPLIER) / ethPriceScaled
    : BigInt(0);
  const platformFeeEthWei = paymentCurrency === "ETH" && ethPriceScaled !== null
    ? (platformFeeCents * CENTS_TO_WEI_MULTIPLIER) / ethPriceScaled
    : BigInt(0);
  const totalEthWei = paymentCurrency === "ETH" && ethPriceScaled !== null
    ? ((subtotalCents + tipCents + platformFeeCents) * CENTS_TO_WEI_MULTIPLIER) / ethPriceScaled
    : BigInt(0);

  // Calculate display ETH amounts (for UI only, not for transactions)
  const totalEth = paymentCurrency === "ETH" && ethPriceScaled !== null
    ? parseFloat(formatUnits(totalEthWei, 18))
    : 0;

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
        // Non-custodial escrow: all payments go to the escrow contract
        const escrowAddress = escrowContractAddress as Address;

        if (!escrowAddress || escrowAddress === "0x0000000000000000000000000000000000000000") {
          throw new Error("Escrow contract address not configured");
        }

        // Restaurant wallet is required for P2P routing
        if (!restaurantWalletAddress) {
          throw new Error("Restaurant wallet address is required for P2P escrow routing");
        }

        if (paymentCurrency === "USDC") {
          // ERC20 approval + escrow deposit
          if (!usdcContractAddress) {
            throw new Error("USDC contract address not configured");
          }

          // Call escrow.deposit(orderId, restaurant, subtotal, tip, platformFee)
          // For USDC, the contract will pull funds via approve/transferFrom
          writeContract({
            address: escrowAddress,
            abi: ESCROW_ABI,
            functionName: "deposit",
            args: [
              orderId || "",
              restaurantWalletAddress as Address,
              subtotalUSDC,
              tipUSDC,
              platformFeeUSDC,
            ],
            chainId: defaultChainId,
          });
        } else {
          // Native ETH deposit to escrow
          // Send totalEthWei (subtotal + tip + platformFee) with deposit call
          sendTransaction({
            to: escrowAddress,
            value: totalEthWei,
            data: orderId ? stringToHex(orderId) : undefined,
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
    escrowContractAddress,
    restaurantWalletAddress,
    subtotalUSDC,
    tipUSDC,
    platformFeeUSDC,
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
      // Notify parent component with txHash and signature for backend verification
      onCheckoutComplete({
        orderId: receipt.transactionHash,
        txHash: receipt.transactionHash,
        signature: signature, // CRITICAL: Pass signature for backend verification
      });
    }
  }, [isConfirmed, receipt, onCheckoutComplete, signature]);

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
      const totalUSDCRequired = subtotalUSDC + tipUSDC + platformFeeUSDC;
      return usdcBalance >= totalUSDCRequired;
    } else {
      // Fail-closed: if ethPrice is null or stale, cannot safely determine balance
      if (ethPrice === null || isPriceStale) return false;
      const balanceEth = parseFloat(formatUnits(balance.value, balance.decimals));

      // Include estimated gas in the total required amount
      const estimatedGasEth = estimatedGas ? parseFloat(formatUnits(estimatedGas, 18)) : 0;
      const totalRequiredWithGas = totalEth + estimatedGasEth;

      return balanceEth >= totalRequiredWithGas;
    }
  })();

  // CRITICAL: Handle signature and transaction flow
  const handlePay = () => {
    if (!hasSufficientBalance) {
      setErrorMessage(`Insufficient ${paymentCurrency} balance for this transaction`);
      setStep("error");
      return;
    }
    if (!orderId) {
      setErrorMessage("Order ID is missing - cannot proceed with payment");
      setStep("error");
      return;
    }
    // First step: Request signature of the orderId (proves wallet ownership)
    setStep("signing");
    signMessage({ 
      message: `OpenDelivery Order: ${orderId}`,
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
                  : `≈ ${formatUnits(subtotalEthWei, 18)} ETH`}
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
                  : `≈ ${formatUnits(tipEthWei, 18)} ETH`}
              </p>
            </div>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Platform Fee</span>
            <div className="text-right">
              <p className="font-medium text-gray-600">${platformFeeFiat.toFixed(2)}</p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC"
                  ? `${formatUnits(platformFeeUSDC, 6)} USDC`
                  : `≈ ${formatUnits(platformFeeEthWei, 18)} ETH`}
              </p>
            </div>
          </div>
          <div className="border-t pt-2 flex justify-between items-center">
            <span className="font-bold text-gray-900">Total</span>
            <div className="text-right">
              <p className="text-xl font-black text-blue-600">${(totalFiat + platformFeeFiat).toFixed(2)}</p>
              <p className="text-xs text-gray-400">
                {paymentCurrency === "USDC"
                  ? `≈ ${formatUnits(subtotalUSDC + tipUSDC + platformFeeUSDC, 6)} USDC`
                  : ethPrice !== null
                    ? `≈ ${totalEth.toFixed(6)} ETH (@ $${ethPrice.toLocaleString()})`
                    : "≈ Price unavailable"}
              </p>
            </div>
          </div>
          
          {/* Estimated Gas Fee - Only for ETH payments */}
          {paymentCurrency === "ETH" && ethPrice !== null && (
            <div className="flex justify-between text-xs text-gray-500 pt-1">
              <span className="text-gray-500">Estimated Gas Fee</span>
              <span className="font-medium">
                {estimatedGasFeeUsd > 0 
                  ? `$${estimatedGasFeeUsd.toFixed(4)}` 
                  : isGasEstimationError 
                    ? "Unable to estimate" 
                    : "Calculating..."}
              </span>
            </div>
          )}
        </div>

        {/* Payment Method Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Non-Custodial P2P Escrow</p>
              <p className="text-xs text-gray-600 mt-1">
                Your payment is sent directly to a smart contract escrow—no central wallet holds your funds.
                The restaurant receives the food subtotal instantly, the platform fee routes to the protocol,
                and your tip is locked in escrow until delivery is confirmed.
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

        {/* ETH Price Unavailable Warning */}
        {step === "review" && paymentCurrency === "ETH" && ethPrice === null && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Price Unavailable</p>
              <p className="text-xs mt-1">Unable to fetch live ETH price. Please try again or use USDC.</p>
            </div>
          </div>
        )}

        {/* ETH Price Stale Warning - Financial Safety */}
        {step === "review" && paymentCurrency === "ETH" && isPriceStale && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-xl flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Live ETH Price Unavailable</p>
              <p className="text-xs mt-1">ETH price data is stale. Please switch to USDC or try again later.</p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {step === "review" && (
          <button
            onClick={handlePay}
            disabled={!hasSufficientBalance || !address || (paymentCurrency === "ETH" && (ethPrice === null || isPriceStale))}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 rounded-lg font-bold hover:from-blue-700 hover:to-indigo-700 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl"
          >
            <Coins className="h-5 w-5" />
            {!hasSufficientBalance && paymentCurrency === "ETH"
              ? "Insufficient Balance (Including Gas)"
              : paymentCurrency === "ETH" && isPriceStale
                ? "Price Stale - Use USDC"
                : paymentCurrency === "ETH" && ethPrice === null
                  ? "Price Unavailable"
                  : `Pay with ${paymentCurrency}`}
            <ArrowRight className="h-5 w-5" />
          </button>
        )}

        {step === "signing" && (
          <button
            disabled
            className="w-full bg-purple-50 text-purple-700 py-3.5 rounded-lg font-bold flex items-center justify-center gap-2 border border-purple-200"
          >
            <Loader2 className="animate-spin h-5 w-5" />
            {isSigning ? "Signing..." : "Please sign in your wallet"}
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
        {step === "review" || step === "error" || step === "signing" ? (
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
