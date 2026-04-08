/**
 * Escrow Contract ABI
 * Non-custodial P2P escrow for food delivery payments.
 *
 * Functions:
 * - deposit(orderId, restaurant, subtotal, tip, platformFee) - Customer deposits funds
 * - releaseTip(orderId, driver) - Backend releases tip to driver (resolver-only)
 *
 * Events:
 * - OrderDeposited(orderId, customer, restaurant) - Emitted on deposit
 * - TipReleased(orderId, driver) - Emitted when tip is released
 */
export const ESCROW_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "orderId", type: "string" },
      { name: "restaurant", type: "address" },
      { name: "subtotal", type: "uint256" },
      { name: "tip", type: "uint256" },
      { name: "platformFee", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "releaseTip",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "string" },
      { name: "driver", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "getOrderTip",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "string" }],
    outputs: [{ name: "tip", type: "uint256" }],
  },
  {
    name: "OrderDeposited",
    type: "event",
    anonymous: false,
    inputs: [
      { indexed: false, name: "orderId", type: "string" },
      { indexed: true, name: "customer", type: "address" },
      { indexed: true, name: "restaurant", type: "address" },
      { indexed: false, name: "subtotal", type: "uint256" },
      { indexed: false, name: "tip", type: "uint256" },
      { indexed: false, name: "platformFee", type: "uint256" },
    ],
  },
  {
    name: "TipReleased",
    type: "event",
    anonymous: false,
    inputs: [
      { indexed: false, name: "orderId", type: "string" },
      { indexed: true, name: "driver", type: "address" },
      { indexed: false, name: "tipAmount", type: "uint256" },
    ],
  },
] as const;
