/**
 * OpenAPI Specification for TableStack API
 *
 * This file contains the complete OpenAPI 3.1 specification for all TableStack APIs.
 * Auto-generated from API route handlers and validation schemas.
 *
 * @see https://swagger.io/specification/
 * @see Phase 2.2: API Documentation
 */

export const openApiSpecification = {
  openapi: '3.1.0',
  info: {
    title: 'TableStack API',
    description: `
# TableStack API Documentation

TableStack is a comprehensive restaurant management platform with reservation handling, 
waitlist management, Web3 payment integration, and real-time updates.

## Features

- **Reservations**: Create, manage, and verify restaurant reservations
- **Waitlist**: Real-time waitlist management with notifications
- **Web3 Payments**: USDC/ETH payment processing with on-chain verification
- **Real-time Updates**: WebSocket-based live updates via Ably
- **Multi-tenant**: Support for multiple restaurants with isolated data

## Authentication

TableStack supports multiple authentication methods:

### API Key Authentication (Legacy)
\`\`\`
x-api-key: ts_your_api_key
\`\`\`

### JWT Bearer Token (Recommended)
\`\`\`
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
\`\`\`

### Scoped Permissions
JWT tokens can include tool-level permissions for fine-grained access control.

## Rate Limiting

| Tier | Requests/minute | Requests/hour |
|------|-----------------|---------------|
| Free | 60 | 1,000 |
| Pro | 300 | 10,000 |
| Enterprise | 1,000 | 50,000 |

Rate limit headers are included in all responses:
- \`X-RateLimit-Limit\`: Maximum requests allowed
- \`X-RateLimit-Remaining\`: Requests remaining in window
- \`X-RateLimit-Reset\`: Unix timestamp when limit resets

## Response Format

All API responses follow a consistent format:

### Success Response
\`\`\`json
{
  "success": true,
  "data": { ... },
  "message": "Operation completed successfully",
  "timestamp": "2024-01-15T10:30:00Z",
  "traceId": "trace-123"
}
\`\`\`

### Error Response
\`\`\`json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": {
      "field": "email",
      "value": "invalid"
    }
  },
  "timestamp": "2024-01-15T10:30:00Z",
  "traceId": "trace-123"
}
\`\`\`

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Request validation failed |
| UNAUTHORIZED | 401 | Missing or invalid authentication |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| CONFLICT | 409 | Resource conflict (e.g., double booking) |
| RATE_LIMITED | 429 | Too many requests |
| DATABASE_ERROR | 500 | Database operation failed |
| EXTERNAL_SERVICE_ERROR | 500 | Third-party service failed |

## Webhooks

TableStack sends webhook notifications for:
- Reservation created/confirmed/cancelled
- Waitlist status changes
- Payment confirmations
- High-value guest alerts

Configure webhook endpoints in your restaurant dashboard.
    `,
    version: '2.0.0',
    contact: {
      name: 'TableStack Support',
      email: 'support@tablestack.io',
      url: 'https://tablestack.io/support',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
    termsOfService: 'https://tablestack.io/terms',
  },
  servers: [
    {
      url: 'https://api.tablestack.io',
      description: 'Production server',
    },
    {
      url: 'https://staging-api.tablestack.io',
      description: 'Staging server',
    },
    {
      url: 'http://localhost:3000',
      description: 'Local development',
    },
  ],
  tags: [
    {
      name: 'Reservations',
      description: 'Restaurant reservation management',
    },
    {
      name: 'Availability',
      description: 'Table availability checking',
    },
    {
      name: 'Waitlist',
      description: 'Waitlist management',
    },
    {
      name: 'Payments',
      description: 'Web3 payment processing',
    },
    {
      name: 'Restaurants',
      description: 'Restaurant management',
    },
    {
      name: 'Verification',
      description: 'Reservation verification',
    },
    {
      name: 'Health',
      description: 'Health and readiness checks',
    },
    {
      name: 'Webhooks',
      description: 'Webhook management',
    },
  ],
  paths: {
    // ========================================================================
    // RESERVATIONS
    // ========================================================================
    '/api/v1/reserve': {
      post: {
        tags: ['Reservations'],
        summary: 'Create a new reservation',
        description: `
Create a new restaurant reservation with guest information.

## Process Flow

1. **Validate Request**: Check required fields and format
2. **Check Availability**: Verify table availability for requested time
3. **Create Reservation**: Insert reservation record
4. **Guest Profile**: Create or update guest profile
5. **Send Verification**: Email verification link to guest
6. **High-Value Hook**: Trigger alerts for frequent guests (5+ visits)

## Idempotency

Include \`X-Idempotency-Key\` header to prevent duplicate reservations.
        `,
        operationId: 'createReservation',
        security: [
          { apiKey: [] },
          { bearerAuth: [] },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ReserveRequest',
              },
              examples: {
                standard: {
                  summary: 'Standard Reservation',
                  value: {
                    guestName: 'John Doe',
                    guestEmail: 'john@example.com',
                    partySize: 4,
                    startTime: '2024-01-15T19:00:00Z',
                    specialRequests: 'Window seat preferred',
                    occasion: 'birthday',
                  },
                },
                withRestaurant: {
                  summary: 'Reservation with Restaurant ID',
                  value: {
                    restaurantId: '550e8400-e29b-41d4-a716-446655440000',
                    guestName: 'Jane Smith',
                    guestEmail: 'jane@example.com',
                    partySize: 2,
                    startTime: '2024-01-16T20:00:00Z',
                    tableId: '550e8400-e29b-41d4-a716-446655440001',
                  },
                },
              },
            },
          },
        },
        parameters: [
          {
            name: 'X-Idempotency-Key',
            in: 'header',
            description: 'Unique key to prevent duplicate reservations',
            required: false,
            schema: {
              type: 'string',
              format: 'uuid',
            },
          },
        ],
        responses: {
          '200': {
            description: 'Reservation created successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ReserveResponse',
                },
                examples: {
                  success: {
                    summary: 'Reservation Created',
                    value: {
                      success: true,
                      data: {
                        message: 'Reservation created. Please check your email to verify.',
                        bookingId: '550e8400-e29b-41d4-a716-446655440002',
                        verificationToken: 'verify-abc123',
                      },
                      timestamp: '2024-01-15T10:30:00Z',
                      traceId: 'trace-123',
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ValidationError',
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
          },
          '403': {
            description: 'Forbidden - Unauthorized restaurant access',
          },
          '409': {
            description: 'Conflict - Table already booked',
            content: {
              'application/json': {
                example: {
                  success: false,
                  error: {
                    code: 'CONFLICT',
                    message: 'No suitable tables available for this time and party size',
                  },
                  timestamp: '2024-01-15T10:30:00Z',
                },
              },
            },
          },
          '429': {
            description: 'Rate limit exceeded',
          },
        },
      },
    },

    // ========================================================================
    // AVAILABILITY
    // ========================================================================
    '/api/v1/availability': {
      get: {
        tags: ['Availability'],
        summary: 'Check table availability',
        description: `
Check available tables for a specific date, time, and party size.

## Features

- **Real-time Availability**: Checks confirmed and pending reservations
- **Table Combination**: Suggests combining adjacent tables if needed
- **Alternative Slots**: Suggests nearby times if requested slot unavailable
- **Restaurant Hours**: Validates against restaurant operating hours
        `,
        operationId: 'checkAvailability',
        security: [
          { apiKey: [] },
          { bearerAuth: [] },
        ],
        parameters: [
          {
            name: 'restaurantId',
            in: 'query',
            description: 'Restaurant UUID',
            required: true,
            schema: {
              type: 'string',
              format: 'uuid',
            },
          },
          {
            name: 'date',
            in: 'query',
            description: 'Requested date (ISO 8601)',
            required: true,
            schema: {
              type: 'string',
              format: 'date-time',
            },
            example: '2024-01-15T19:00:00Z',
          },
          {
            name: 'partySize',
            in: 'query',
            description: 'Number of guests',
            required: true,
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
            },
            example: 4,
          },
        ],
        responses: {
          '200': {
            description: 'Availability check successful',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/AvailabilityResponse',
                },
                examples: {
                  available: {
                    summary: 'Tables Available',
                    value: {
                      success: true,
                      data: {
                        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
                        requestedTime: '2024-01-15T19:00:00Z',
                        partySize: 4,
                        availableTables: [
                          {
                            tableId: '550e8400-e29b-41d4-a716-446655440001',
                            tableNumber: 'T5',
                            minCapacity: 2,
                            maxCapacity: 6,
                            isCombined: false,
                          },
                        ],
                      },
                      timestamp: '2024-01-15T10:30:00Z',
                    },
                  },
                  withSuggestions: {
                    summary: 'No Tables - Alternative Suggestions',
                    value: {
                      success: true,
                      data: {
                        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
                        requestedTime: '2024-01-15T19:00:00Z',
                        partySize: 4,
                        availableTables: [],
                        suggestedSlots: [
                          {
                            time: '2024-01-15T18:30:00Z',
                            availableTables: [
                              {
                                tableId: '550e8400-e29b-41d4-a716-446655440002',
                                tableNumber: 'T3',
                                minCapacity: 2,
                                maxCapacity: 4,
                                isCombined: false,
                              },
                            ],
                          },
                        ],
                      },
                      timestamp: '2024-01-15T10:30:00Z',
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid parameters',
          },
          '404': {
            description: 'Restaurant not found',
          },
        },
      },
    },

    // ========================================================================
    // VERIFICATION
    // ========================================================================
    '/api/v1/verify': {
      post: {
        tags: ['Verification'],
        summary: 'Verify reservation',
        description: 'Verify a reservation using the token sent via email.',
        operationId: 'verifyReservation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/VerifyRequest',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Reservation verified successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/VerifyResponse',
                },
              },
            },
          },
          '404': {
            description: 'Invalid or expired token',
          },
        },
      },
    },

    // ========================================================================
    // CHECKOUT / PAYMENTS
    // ========================================================================
    '/api/v1/checkout': {
      post: {
        tags: ['Payments'],
        summary: 'Process Web3 payment',
        description: `
Verify and process a Web3 payment (ETH or USDC).

## Supported Tokens

- **ETH** (Base network)
- **USDC** (Base network)
- **USDT** (Base network)

## Verification Process

1. **Replay Prevention**: Check if transaction was already processed
2. **Signature Verification**: Verify cryptographic signature
3. **Transaction Lookup**: Fetch transaction from blockchain
4. **Recipient Check**: Verify payment went to correct address
5. **Amount Check**: Verify payment amount matches order
6. **Confirmation Wait**: Wait for minimum confirmations
7. **Register Transaction**: Record in replay prevention table
        `,
        operationId: 'processPayment',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CheckoutRequest',
              },
              examples: {
                eth: {
                  summary: 'ETH Payment',
                  value: {
                    txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
                    orderId: 'order-123',
                    amount: '0.005',
                    currency: 'ETH',
                    chainId: 8453,
                    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
                    signature: '0xabc123...',
                  },
                },
                usdc: {
                  summary: 'USDC Payment',
                  value: {
                    txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
                    orderId: 'order-456',
                    amount: '10.50',
                    currency: 'USDC',
                    chainId: 8453,
                    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
                    signature: '0xdef456...',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Payment processed successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CheckoutResponse',
                },
              },
            },
          },
          '400': {
            description: 'Invalid payment data',
          },
          '409': {
            description: 'Transaction already processed (replay detected)',
          },
        },
      },
    },

    // ========================================================================
    // WAITLIST
    // ========================================================================
    '/api/v1/waitlist': {
      post: {
        tags: ['Waitlist'],
        summary: 'Join waitlist',
        description: 'Add a party to the restaurant waitlist.',
        operationId: 'joinWaitlist',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/JoinWaitlistRequest',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Added to waitlist',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WaitlistResponse',
                },
              },
            },
          },
        },
      },
      get: {
        tags: ['Waitlist'],
        summary: 'Get waitlist entries',
        description: `
Retrieve the waitlist entries for a restaurant.

## Authentication

Requires Bearer JWT token (service-to-service) or API key.

## Pagination

Supports pagination with \`limit\` and \`offset\` query parameters.
        `,
        operationId: 'getWaitlist',
        security: [
          { apiKey: [] },
          { bearerAuth: [] },
        ],
        parameters: [
          {
            name: 'restaurantId',
            in: 'query',
            description: 'Restaurant UUID',
            required: true,
            schema: {
              type: 'string',
              format: 'uuid',
            },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Number of entries to return (max 100)',
            required: false,
            schema: {
              type: 'integer',
              default: 50,
              maximum: 100,
            },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of entries to skip',
            required: false,
            schema: {
              type: 'integer',
              default: 0,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Waitlist entries retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        restaurantId: { type: 'string', format: 'uuid' },
                        waitlistCount: { type: 'integer' },
                        totalCount: { type: 'integer' },
                        pagination: {
                          type: 'object',
                          properties: {
                            limit: { type: 'integer' },
                            offset: { type: 'integer' },
                            hasMore: { type: 'boolean' },
                          },
                        },
                        entries: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string', format: 'uuid' },
                              guestName: { type: 'string' },
                              guestEmail: { type: 'string', format: 'email' },
                              partySize: { type: 'integer' },
                              status: { type: 'string', enum: ['waiting', 'notified', 'seated'] },
                              createdAt: { type: 'string', format: 'date-time' },
                            },
                          },
                        },
                      },
                    },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid parameters',
          },
          '401': {
            description: 'Unauthorized',
          },
          '403': {
            description: 'Forbidden',
          },
        },
      },
    },

    // ========================================================================
    // HEALTH CHECKS
    // ========================================================================
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Check service health status. Used by load balancers and Kubernetes.',
        operationId: 'healthCheck',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse',
                },
                example: {
                  status: 'healthy',
                  service: 'table-stack',
                  version: '2.0.0',
                  timestamp: '2024-01-15T10:30:00Z',
                  responseTimeMs: 12,
                  checks: [
                    {
                      name: 'database',
                      status: 'healthy',
                      responseTimeMs: 5,
                    },
                    {
                      name: 'redis',
                      status: 'healthy',
                      responseTimeMs: 2,
                    },
                  ],
                },
              },
            },
          },
          '503': {
            description: 'Service is unhealthy',
          },
        },
      },
    },
    '/api/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness check',
        description: 'Check if service is ready to accept traffic. Used by Kubernetes readiness probes.',
        operationId: 'readinessCheck',
        responses: {
          '200': {
            description: 'Service is ready',
            content: {
              'application/json': {
                example: {
                  ready: true,
                  timestamp: '2024-01-15T10:30:00Z',
                },
              },
            },
          },
          '503': {
            description: 'Service is not ready',
            content: {
              'application/json': {
                example: {
                  ready: false,
                  reason: 'Database connection failed',
                  timestamp: '2024-01-15T10:30:00Z',
                },
              },
            },
          },
        },
      },
    },
  },

  // ============================================================================
  // COMPONENTS
  // ============================================================================
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header',
        description: 'API key for restaurant authentication (legacy)',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT bearer token for service-to-service authentication',
      },
    },
    schemas: {
      // Request Schemas
      ReserveRequest: {
        type: 'object',
        required: ['guestName', 'guestEmail', 'partySize', 'startTime'],
        properties: {
          restaurantId: {
            type: 'string',
            format: 'uuid',
            description: 'Restaurant UUID (optional if using API key auth)',
          },
          restaurantName: {
            type: 'string',
            description: 'Restaurant name for shadow creation',
          },
          tableId: {
            type: 'string',
            format: 'uuid',
            description: 'Specific table UUID (optional, auto-assigned if not provided)',
          },
          guestName: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'Guest full name',
            example: 'John Doe',
          },
          guestEmail: {
            type: 'string',
            format: 'email',
            description: 'Guest email address',
            example: 'john@example.com',
          },
          guestPhone: {
            type: 'string',
            pattern: '^\\+?[1-9]\\d{1,14}$',
            description: 'Guest phone number (international format)',
            example: '+1234567890',
          },
          partySize: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Number of guests',
            example: 4,
          },
          startTime: {
            type: 'string',
            format: 'date-time',
            description: 'Reservation start time (ISO 8601)',
            example: '2024-01-15T19:00:00Z',
          },
          duration: {
            type: 'integer',
            minimum: 30,
            maximum: 300,
            default: 90,
            description: 'Reservation duration in minutes',
          },
          specialRequests: {
            type: 'string',
            maxLength: 1000,
            description: 'Special requests or dietary requirements',
            example: 'Window seat preferred, gluten-free options needed',
          },
          occasion: {
            type: 'string',
            enum: ['birthday', 'anniversary', 'business', 'other'],
            description: 'Special occasion',
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: 'Additional metadata',
          },
        },
      },

      ReserveResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: true,
          },
          data: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                example: 'Reservation created. Please check your email to verify.',
              },
              bookingId: {
                type: 'string',
                format: 'uuid',
              },
              verificationToken: {
                type: 'string',
              },
              verificationUrl: {
                type: 'string',
                format: 'uri',
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          traceId: {
            type: 'string',
          },
        },
      },

      AvailabilityResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
          },
          data: {
            type: 'object',
            properties: {
              restaurantId: {
                type: 'string',
                format: 'uuid',
              },
              requestedTime: {
                type: 'string',
                format: 'date-time',
              },
              partySize: {
                type: 'integer',
              },
              availableTables: {
                type: 'array',
                items: {
                  $ref: '#/components/schemas/TableAvailability',
                },
              },
              suggestedSlots: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    time: {
                      type: 'string',
                      format: 'date-time',
                    },
                    availableTables: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/TableAvailability',
                      },
                    },
                  },
                },
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
        },
      },

      TableAvailability: {
        type: 'object',
        properties: {
          tableId: {
            type: 'string',
            format: 'uuid',
          },
          tableNumber: {
            type: 'string',
          },
          minCapacity: {
            type: 'integer',
          },
          maxCapacity: {
            type: 'integer',
          },
          isCombined: {
            type: 'boolean',
            description: 'Whether this is a combination of multiple tables',
          },
          combinedTableIds: {
            type: 'array',
            items: {
              type: 'string',
              format: 'uuid',
            },
            description: 'Table IDs if this is a combined table',
          },
        },
      },

      VerifyRequest: {
        type: 'object',
        required: ['token'],
        properties: {
          token: {
            type: 'string',
            description: 'Verification token from email',
          },
        },
      },

      VerifyResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
          },
          data: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
              },
              reservationId: {
                type: 'string',
                format: 'uuid',
              },
              status: {
                type: 'string',
                enum: ['confirmed', 'cancelled', 'expired'],
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
        },
      },

      CheckoutRequest: {
        type: 'object',
        required: ['txHash', 'orderId', 'amount', 'currency'],
        properties: {
          txHash: {
            type: 'string',
            pattern: '^0x[a-fA-F0-9]{64}$',
            description: 'On-chain transaction hash',
          },
          orderId: {
            type: 'string',
            description: 'Order or reservation ID',
          },
          amount: {
            type: 'string',
            pattern: '^\\d+(\\.\\d+)?$',
            description: 'Payment amount',
          },
          currency: {
            type: 'string',
            enum: ['ETH', 'USDC', 'USDT', 'DAI'],
          },
          chainId: {
            type: 'integer',
            default: 8453,
            description: 'Blockchain chain ID (8453 = Base)',
          },
          walletAddress: {
            type: 'string',
            pattern: '^0x[a-fA-F0-9]{40}$',
            description: 'Sender wallet address',
          },
          signature: {
            type: 'string',
            pattern: '^0x[a-fA-F0-9]+$',
            description: 'Cryptographic signature of orderId',
          },
          minConfirmations: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 3,
          },
        },
      },

      CheckoutResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
          },
          data: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
              },
              orderId: {
                type: 'string',
              },
              paymentStatus: {
                type: 'string',
                enum: ['pending', 'confirming', 'confirmed', 'completed', 'failed'],
              },
              txHash: {
                type: 'string',
              },
              confirmations: {
                type: 'integer',
              },
              receipt: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['success', 'reverted'],
                  },
                  blockNumber: {
                    type: 'string',
                  },
                  from: {
                    type: 'string',
                  },
                  to: {
                    type: 'string',
                    nullable: true,
                  },
                  value: {
                    type: 'string',
                  },
                },
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
        },
      },

      JoinWaitlistRequest: {
        type: 'object',
        required: ['restaurantId', 'guestName', 'guestEmail', 'partySize'],
        properties: {
          restaurantId: {
            type: 'string',
            format: 'uuid',
          },
          guestName: {
            type: 'string',
          },
          guestEmail: {
            type: 'string',
            format: 'email',
          },
          guestPhone: {
            type: 'string',
          },
          partySize: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
          },
          notes: {
            type: 'string',
            maxLength: 500,
          },
        },
      },

      WaitlistResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
          },
          data: {
            type: 'object',
            properties: {
              waitlistId: {
                type: 'string',
                format: 'uuid',
              },
              position: {
                type: 'integer',
              },
              estimatedWaitTime: {
                type: 'integer',
                description: 'Estimated wait time in minutes',
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
        },
      },

      WaitlistPositionResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
          },
          data: {
            type: 'object',
            properties: {
              position: {
                type: 'integer',
              },
              estimatedWaitTime: {
                type: 'integer',
              },
              partySize: {
                type: 'integer',
              },
              joinedAt: {
                type: 'string',
                format: 'date-time',
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
        },
      },

      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['healthy', 'unhealthy', 'degraded'],
          },
          service: {
            type: 'string',
          },
          version: {
            type: 'string',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          responseTimeMs: {
            type: 'integer',
          },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                },
                status: {
                  type: 'string',
                  enum: ['healthy', 'unhealthy', 'degraded'],
                },
                responseTimeMs: {
                  type: 'integer',
                },
              },
            },
          },
        },
      },

      ValidationError: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: false,
          },
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                example: 'VALIDATION_ERROR',
              },
              message: {
                type: 'string',
                example: 'Validation failed',
              },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field: {
                      type: 'string',
                    },
                    message: {
                      type: 'string',
                    },
                    code: {
                      type: 'string',
                    },
                  },
                },
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          traceId: {
            type: 'string',
          },
        },
      },
    },
  },
} as const;

// Type exports
export type OpenApiSpecification = typeof openApiSpecification;
