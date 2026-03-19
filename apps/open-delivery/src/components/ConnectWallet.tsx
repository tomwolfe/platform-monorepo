"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useBalance } from "wagmi";
import { Wallet, LogOut, Copy, Check, ChevronDown } from "lucide-react";

/**
 * ConnectWallet Component
 * 
 * Provides wallet connection UI with:
 * - Connect/Disconnect buttons
 * - Address display with copy functionality
 * - Balance display for connected chain
 * - Dropdown for account details
 */
export function ConnectWallet() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, status } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({
    address,
    chainId: chain?.id,
  });

  const [showDropdown, setShowDropdown] = useState(false);
  const [copied, setCopied] = useState(false);

  // Shorten address for display (e.g., 0x1234...5678)
  const shortenAddress = (addr: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // Copy address to clipboard
  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle connection
  const handleConnect = (connector: typeof connectors[number]) => {
    connect({ connector });
  };

  // Format balance for display
  const formatBalance = (bal: typeof balance) => {
    if (!bal) return "0.0000";
    // In wagmi v3, balance uses 'value' (bigint) and 'decimals'
    const { formatUnits } = require("viem");
    return parseFloat(formatUnits(bal.value, bal.decimals)).toFixed(4);
  };

  if (!isConnected) {
    return (
      <div className="relative">
        <details className="group">
          <summary className="list-none cursor-pointer">
            <div className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md hover:shadow-lg">
              <Wallet className="h-4 w-4" />
              {status === "pending" ? "Connecting..." : "Connect Wallet"}
              <ChevronDown className="h-4 w-4 ml-1" />
            </div>
          </summary>
          <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border z-50 overflow-hidden">
            <div className="p-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50">
              <p className="text-sm font-semibold text-gray-900">Connect Wallet</p>
              <p className="text-xs text-gray-500 mt-1">Choose your preferred wallet</p>
            </div>
            <div className="p-2 space-y-1">
              {connectors.map((connector) => (
                <button
                  key={connector.id}
                  onClick={() => handleConnect(connector)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-100 transition-colors text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center">
                    <Wallet className="h-4 w-4 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sm text-gray-900">
                      {connector.name === "Coinbase Wallet" ? "Coinbase" : connector.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {connector.name === "Coinbase Wallet" ? "Recommended for beginners" : "Popular choice"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="relative">
      <details open={showDropdown} onToggle={(e) => setShowDropdown((e.target as HTMLDetailsElement).open)}>
        <summary className="list-none">
          <button className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-emerald-500 to-green-500 text-white rounded-lg font-medium hover:from-emerald-600 hover:to-green-600 transition-all shadow-md">
            <div className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center">
              <span className="text-xs font-bold">{address?.slice(2, 4)}</span>
            </div>
            <span className="text-sm">{shortenAddress(address || "")}</span>
            {balance && (
              <span className="text-xs opacity-90 ml-1">
                {formatBalance(balance)} {balance.symbol}
              </span>
            )}
            <ChevronDown className="h-3 w-3 ml-1" />
          </button>
        </summary>
        <div className="absolute right-0 mt-2 w-72 bg-white rounded-xl shadow-xl border z-50 overflow-hidden">
          <div className="p-4 border-b bg-gradient-to-r from-emerald-50 to-green-50">
            <p className="text-sm font-semibold text-gray-900">Connected</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-gray-600">{shortenAddress(address || "")}</span>
              <button
                onClick={copyAddress}
                className="p-1 hover:bg-white/50 rounded transition-colors"
                title="Copy address"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-600" />
                ) : (
                  <Copy className="h-3 w-3 text-gray-600" />
                )}
              </button>
            </div>
          </div>
          
          {balance && (
            <div className="p-3 border-b">
              <p className="text-xs text-gray-500 mb-1">Balance</p>
              <p className="text-lg font-bold text-gray-900">
                {formatBalance(balance)} {balance.symbol}
              </p>
              {chain && (
                <p className="text-xs text-gray-500 mt-1">
                  on {chain.name}
                </p>
              )}
            </div>
          )}
          
          <div className="p-2">
            <button
              onClick={() => {
                disconnect();
                setShowDropdown(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-red-50 text-red-600 transition-colors text-sm font-medium"
            >
              <LogOut className="h-4 w-4" />
              Disconnect
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
