# TableStack API Documentation

Welcome to the TableStack API documentation. This guide provides comprehensive information for integrating with TableStack's restaurant management platform.

## Quick Start

### Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://api.tablestack.io` |
| Staging | `https://staging-api.tablestack.io` |
| Local | `http://localhost:3000` |

### Authentication

```bash
# Using JWT (Recommended)
curl -X GET https://api.tablestack.io/api/v1/availability \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."

# Using API Key (Legacy)
curl -X GET https://api.tablestack.io/api/v1/availability \
  -H "x-api-key: ts_your_api_key"
```

### OpenAPI Specification

Access the complete OpenAPI specification:
- JSON: `GET /api/docs/openapi.json`
- Swagger UI: `GET /api/docs` (coming soon)

## Core Endpoints

### Reservations

#### Create Reservation
```http
POST /api/v1/reserve
Content-Type: application/json
Authorization: Bearer {token}
X-Idempotency-Key: {unique-key}
```

```json
{
  "guestName": "John Doe",
  "guestEmail": "john@example.com",
  "partySize": 4,
  "startTime": "2024-01-15T19:00:00Z",
  "specialRequests": "Window seat preferred",
  "occasion": "birthday"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Reservation created. Please check your email to verify.",
    "bookingId": "550e8400-e29b-41d4-a716-446655440002"
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### Check Availability
```http
GET /api/v1/availability?restaurantId={id}&date={iso-date}&partySize={number}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "restaurantId": "550e8400-e29b-41d4-a716-446655440000",
    "requestedTime": "2024-01-15T19:00:00Z",
    "partySize": 4,
    "availableTables": [
      {
        "tableId": "550e8400-e29b-41d4-a716-446655440001",
        "tableNumber": "T5",
        "minCapacity": 2,
        "maxCapacity": 6,
        "isCombined": false
      }
    ],
    "suggestedSlots": []
  }
}
```

### Payments

#### Process Web3 Payment
```http
POST /api/v1/checkout
Content-Type: application/json
```

```json
{
  "txHash": "0x1234567890123456789012345678901234567890123456789012345678901234",
  "orderId": "order-123",
  "amount": "10.50",
  "currency": "USDC",
  "chainId": 8453,
  "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
  "signature": "0xabc123..."
}
```

### Waitlist

#### Join Waitlist
```http
POST /api/v1/waitlist
Content-Type: application/json
```

```json
{
  "restaurantId": "550e8400-e29b-41d4-a716-446655440000",
  "guestName": "Jane Smith",
  "guestEmail": "jane@example.com",
  "partySize": 2,
  "notes": "Celebrating anniversary"
}
```

## Error Handling

All errors follow a consistent format:

```json
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
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict |
| `RATE_LIMITED` | 429 | Too many requests |
| `DATABASE_ERROR` | 500 | Database operation failed |

## Rate Limiting

| Tier | Requests/minute | Requests/hour |
|------|-----------------|---------------|
| Free | 60 | 1,000 |
| Pro | 300 | 10,000 |
| Enterprise | 1,000 | 50,000 |

Rate limit headers are included in all responses:
- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Requests remaining
- `X-RateLimit-Reset`: Unix timestamp when limit resets

## Webhooks

Configure webhook endpoints in your restaurant dashboard to receive real-time notifications:

### Events

| Event | Description |
|-------|-------------|
| `reservation.created` | New reservation created |
| `reservation.confirmed` | Reservation verified |
| `reservation.cancelled` | Reservation cancelled |
| `waitlist.joined` | Guest joined waitlist |
| `waitlist.seated` | Guest seated |
| `payment.confirmed` | Payment received |
| `high_value_guest` | Frequent guest booking (5+ visits) |

### Webhook Payload

```json
{
  "eventId": "evt_123",
  "eventType": "reservation.created",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "reservationId": "550e8400-e29b-41d4-a716-446655440002",
    "restaurantId": "550e8400-e29b-41d4-a716-446655440000",
    "guestName": "John Doe",
    "partySize": 4,
    "startTime": "2024-01-15T19:00:00Z"
  }
}
```

## SDKs & Libraries

### JavaScript/TypeScript
```bash
npm install @tablestack/sdk
```

```typescript
import { TableStackClient } from '@tablestack/sdk';

const client = new TableStackClient({
  apiKey: 'ts_your_api_key',
  baseUrl: 'https://api.tablestack.io',
});

// Check availability
const availability = await client.availability.check({
  restaurantId: 'xxx',
  date: '2024-01-15',
  partySize: 4,
});

// Create reservation
const reservation = await client.reservations.create({
  guestName: 'John Doe',
  guestEmail: 'john@example.com',
  partySize: 4,
  startTime: '2024-01-15T19:00:00Z',
});
```

### Python
```bash
pip install tablestack-python
```

```python
from tablestack import TableStackClient

client = TableStackClient(api_key='ts_your_api_key')

# Check availability
availability = client.availability.check(
    restaurant_id='xxx',
    date='2024-01-15',
    party_size=4
)

# Create reservation
reservation = client.reservations.create(
    guest_name='John Doe',
    guest_email='john@example.com',
    party_size=4,
    start_time='2024-01-15T19:00:00Z'
)
```

## Testing

### Sandbox Environment

Use the staging environment for testing:
- Base URL: `https://staging-api.tablestack.io`
- Test API keys start with `ts_test_`
- Test data is reset daily

### Postman Collection

Import our Postman collection:
- Download: [TableStack API.postman_collection.json](./postman/TableStack%20API.postman_collection.json)
- Environment: [TableStack API.postman_environment.json](./postman/TableStack%20API.postman_environment.json)

### cURL Examples

```bash
# Health check
curl https://api.tablestack.io/api/health

# Check availability
curl "https://api.tablestack.io/api/v1/availability?restaurantId=xxx&date=2024-01-15T19:00:00Z&partySize=4" \
  -H "x-api-key: ts_your_api_key"

# Create reservation
curl -X POST https://api.tablestack.io/api/v1/reserve \
  -H "Content-Type: application/json" \
  -H "x-api-key: ts_your_api_key" \
  -d '{
    "guestName": "John Doe",
    "guestEmail": "john@example.com",
    "partySize": 4,
    "startTime": "2024-01-15T19:00:00Z"
  }'
```

## Support

| Channel | URL/Email |
|---------|-----------|
| Documentation | https://docs.tablestack.io |
| API Status | https://status.tablestack.io |
| Support Email | support@tablestack.io |
| Developer Discord | https://discord.gg/tablestack |

## Changelog

See [API_CHANGELOG.md](./API_CHANGELOG.md) for version history and migration guides.

---

**Last Updated:** January 15, 2024
**API Version:** 2.0.0
