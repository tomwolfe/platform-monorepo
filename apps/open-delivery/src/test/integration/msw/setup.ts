/**
 * MSW Integration Test Setup (Open-Delivery)
 *
 * Re-exports centralized handlers from @repo/shared/testing.
 * App-specific test configuration can be added here.
 *
 * @deprecated Import directly from @repo/shared/testing in new tests
 */

export {
  web3RpcHandlers,
  ablyHandlers,
  resendHandlers,
  priceOracleHandlers,
  setupIntegrationMocks,
} from "@repo/shared/testing";
