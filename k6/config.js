export const options = {
  // Discard all metrics except the ones explicitly listed
  discardResponseBodies: true,
  
  // Summary thresholds
  thresholds: {
    // Custom thresholds are defined in individual test scripts
  },
  
  // VU behavior
  noConnectionReuse: false,
  userDefined: {
    // Default environment variables
    BASE_URL: 'http://localhost:3000',
    TEST_USER_ID: 'k6-test-user',
    CLERK_ID: 'test_clerk_id',
  },
};

// Default configuration for all tests
export const config = {
  // Timeouts
  timeout: {
    request: '10s',
    response: '30s',
  },
  
  // Retry configuration
  retry: {
    enabled: false,
    maxAttempts: 3,
    delay: '1s',
  },
  
  // Performance budgets
  budgets: {
    intentInferenceP95: 800,    // ms
    stepExecutionP95: 2000,     // ms
    chatResponseP95: 1500,      // ms
    errorRate: 0.01,            // 1%
  },
};
