# Production Runbooks

## Table of Contents

1. [Recover a Stuck DLQ Saga](#recover-a-stuck-dlq-saga)
2. [Reset Circuit Breaker for Failing Tool](#reset-circuit-breaker-for-failing-tool)
3. [Manually Trigger Payout Cron](#manually-trigger-payout-cron)
4. [Debug LLM Parsing Failures](#debug-llm-parsing-failures)
5. [Handle Web3 Transaction Failures](#handle-web3-transaction-failures)
6. [Reset Nonce Tracker](#reset-nonce-tracker)

---

## Recover a Stuck DLQ Saga

### Symptoms

- Task stuck in `dlq` state for > 30 minutes
- Monitoring alerts for DLQ depth > threshold

### Diagnosis

```bash
# Check DLQ depth (scan for DLQ tasks)
redis-cli --scan --pattern "ie:task:dlq:*"

# Get stuck task details
redis-cli HGETALL "ie:task:{taskId}:state"

# Check task execution history
redis-cli LRANGE "ie:task:{taskId}:history" 0 -1

# Check circuit breaker for the tool that failed
redis-cli GET "ie:circuit-breaker:{toolName}:state"
```

### Recovery

```bash
# Replay a specific task via admin API
curl -X POST https://your-domain/api/admin/dlq/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "task_abc123"}'

# Replay all DLQ tasks (use with caution)
curl -X POST https://your-domain/api/admin/dlq/replay-all \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Or via Redis directly - move task back to pending
redis-cli HSET "ie:task:{taskId}:state" state "pending"
redis-cli LPUSH "ie:task:queue" "{taskId}"
```

### Prevention

- Check circuit breaker status for the tool that failed
- Review tool error logs for pattern changes
- Update tool retry configuration if needed

---

## Reset Circuit Breaker for Failing Tool

### Symptoms

- Tool returning errors consistently
- Circuit breaker in `open` state
- Monitoring alerts for tool failure rate > threshold

### Diagnosis

```bash
# Check circuit breaker state
redis-cli GET "ie:circuit-breaker:{toolName}:state"
# Expected values: "closed", "open", "half-open"

# Get failure count
redis-cli GET "ie:circuit-breaker:{toolName}:failures"

# Get last failure timestamp
redis-cli GET "ie:circuit-breaker:{toolName}:lastFailure"
```

### Recovery

```bash
# Force reset to closed state
redis-cli SET "ie:circuit-breaker:{toolName}:state" "closed"
redis-cli SET "ie:circuit-breaker:{toolName}:failures" "0"
redis-cli DEL "ie:circuit-breaker:{toolName}:lastFailure"

# Or via admin API
curl -X POST https://your-domain/api/admin/circuit-breaker/{toolName}/reset \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### When to Reset

| Condition                            | Verdict         |
| ------------------------------------ | --------------- |
| Upstream service confirmed recovered | ✅ Reset        |
| Tool configuration/parameters fixed  | ✅ Reset        |
| Upstream still failing               | ❌ Will re-trip |

---

## Manually Trigger Payout Cron

### When to Use

- Missed scheduled cron execution
- Need to release tips immediately
- Testing payout flow

### Execution

```bash
# Trigger the payout cron manually
curl -X POST https://your-domain/api/cron/payouts \
  -H "X-Cron-Secret: $CRON_SECRET" \
  -H "Content-Type: application/json"

# Check resolver wallet balance first (via viem or BaseScan)
# Ensure balance > minimum threshold ($15 USD equivalent)

# Monitor execution logs
tail -f logs/open-delivery.log | grep "payout"

# Verify results in database
psql $DATABASE_URL -c "
  SELECT id, status, escrowStatus, releasedAt
  FROM orders
  WHERE escrowStatus IN ('releasing', 'released', 'failed')
  ORDER BY updatedAt DESC LIMIT 10;
"
```

### Troubleshooting

| Error                   | Cause                           | Fix                                          |
| ----------------------- | ------------------------------- | -------------------------------------------- |
| 503 Service Unavailable | Resolver wallet balance too low | Fund wallet                                  |
| nonce too low           | Nonce tracker out of sync       | [Reset nonce tracker](#reset-nonce-tracker)  |
| Transaction reverted    | Contract state issue            | Check contract, may need manual intervention |

---

## Debug LLM Parsing Failures

### Symptoms

- User intent parsed incorrectly
- Tool selection errors
- Parameter extraction failures
- Schema validation failures in structured output

### Diagnosis

```bash
# Check recent LLM call logs (application logs)
tail -f logs/intention-engine.log | grep "LLM"

# Check prompt version being used
grep "CURRENT_VERSIONS" apps/intention-engine/src/prompts/index.ts

# Check model configuration
grep "MODEL_ROUTING" apps/intention-engine/src/lib/engine/llm.ts

# Check if fallback was triggered (look for fallback logs)
tail -f logs/intention-engine.log | grep "fallback"

# Check LLM observability logs for prompt hash/token usage
tail -f logs/intention-engine.log | grep "LLM Observability"
```

### Recovery

1. Review prompt version and changelog in `apps/intention-engine/src/prompts/index.ts`
2. Check if fallback model was activated (look for `LLM fallback triggered` in logs)
3. Review structured output for schema validation failures
4. Update prompt version if systematic parsing issues found
5. Check LLM provider status (OpenAI status page)

### Prevention

- Monitor `LLM Observability` logs for degradation (promptHash, token usage, latency)
- Set alerts on fallback activation rate
- Regularly review prompt versions and update as needed

---

## Handle Web3 Transaction Failures

### Symptoms

- Payout cron returning errors
- Transaction revert alerts
- Driver tip not released

### Diagnosis

```bash
# Check transaction status on BaseScan
curl "https://api.basescan.org/api?module=transaction&action=gettxreceiptstatus&txhash={txHash}&apikey={API_KEY}"

# Check nonce tracker state
redis-cli GET "shared:nonce:{chainId}:{address}"
# chainId for Base mainnet: 8453

# Check resolver wallet balance
# Use viem console or check wallet provider dashboard

# Check gas price at time of transaction
tail -f logs/open-delivery.log | grep "gasPrice"

# Check current blockchain gas price
curl -X POST https://mainnet.base.sepolia.io \
  -H "Content-Type: application/json" \
  -d '{"method":"eth_gasPrice","params":[],"id":1,"jsonrpc":"2.0"}'
```

### Recovery

```bash
# Reset nonce tracker if out of sync
redis-cli DEL "shared:nonce:{chainId}:{address}"

# The nonce tracker will re-sync from the blockchain on next transaction

# Manually fund resolver wallet if balance is low
# Contact wallet administrator for fund transfer
```

---

## Reset Nonce Tracker

### When Needed

- "nonce too low" errors persisting
- After manual transaction submission
- After wallet key rotation

### Steps

```bash
# Delete the cached nonce
redis-cli DEL "shared:nonce:{chainId}:{address}"

# Verify it's cleared
redis-cli GET "shared:nonce:{chainId}:{address}"
# Should return (nil)

# Next payout will fetch fresh nonce from blockchain
# Monitor next cron run for successful nonce usage
```

### Finding the Address

```bash
# Get resolver wallet address from environment or config
cat packages/shared/src/utils/wallet-provider.ts | grep "address"

# The nonce key format is: shared:nonce:{chainId}:{address}
# For Base mainnet: chainId = 8453
```

---

## Quick Reference

### Common Redis Keys

| Pattern                           | Description           | App              |
| --------------------------------- | --------------------- | ---------------- |
| `ie:task:{id}:state`              | Task state machine    | Intention Engine |
| `ie:circuit-breaker:{tool}:state` | Circuit breaker state | Intention Engine |
| `ie:task:dlq:*`                   | Dead letter queue     | Intention Engine |
| `shared:nonce:{chainId}:{addr}`   | Web3 nonce tracker    | Shared           |
| `ts:idempotency:{key}`            | Idempotency cache     | Table Stack      |
| `od:outbox:*`                     | Outbox events         | Open Delivery    |

### Environment Variables

| Variable                      | Description                                   | Required            |
| ----------------------------- | --------------------------------------------- | ------------------- |
| `DATABASE_URL`                | Neon PostgreSQL connection string             | Yes                 |
| `UPSTASH_REDIS_REST_URL`      | Upstash Redis REST endpoint                   | Yes                 |
| `UPSTASH_REDIS_REST_TOKEN`    | Upstash Redis auth token                      | Yes                 |
| `CRON_SECRET`                 | Cron job authentication secret                | Yes                 |
| `ESCROW_RESOLVER_PRIVATE_KEY` | Web3 resolver wallet key                      | Yes (Open Delivery) |
| `ABLY_API_KEY`                | Ably realtime API key                         | Yes                 |
| `RESEND_API_KEY`              | Resend email API key                          | Yes                 |
| `LLM_FALLBACK_MODEL`          | Fallback model for LLM (default: gpt-4o-mini) | No                  |

### Admin Endpoints

| Endpoint                                       | Purpose                | Auth          |
| ---------------------------------------------- | ---------------------- | ------------- |
| `POST /api/admin/dlq/replay`                   | Replay single DLQ task | `ADMIN_TOKEN` |
| `POST /api/admin/dlq/replay-all`               | Replay all DLQ tasks   | `ADMIN_TOKEN` |
| `POST /api/admin/circuit-breaker/{tool}/reset` | Reset circuit breaker  | `ADMIN_TOKEN` |
| `POST /api/cron/payouts`                       | Manual payout trigger  | `CRON_SECRET` |
