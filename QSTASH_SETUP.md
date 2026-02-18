# QStash Setup Guide - Vercel Hobby Tier

## Overview

Your intention engine already has **90% of QStash integration complete**. This guide will help you activate it to replace the unreliable `fetch(self)` recursion pattern with **guaranteed queue-based execution**.

### Why QStash?

| Problem | Current Approach | QStash Solution |
|---------|-----------------|-----------------|
| **Unreliable triggers** | `fetch(self)` with fire-and-forget | Queue-based message delivery |
| **No retry logic** | If step fails, workflow dies | Automatic retries with backoff |
| **No dead-letter queue** | Failed executions lost | Failed messages captured for review |
| **No scheduling** | Complex delay implementation | Built-in delay/cron support |
| **Vercel timeout** | 10s hard limit | Infinite duration via chunking |

### Free Tier Limits (Sufficient for Hobby)

- **10,000 requests/day**
- **100,000 messages/month**
- **100 concurrent executions**

---

## Step 1: Create Upstash QStash Database

1. Go to **https://console.upstash.io** and log in (or create account)
2. Click **"Create Database"** or navigate to the **QStash** section
3. Create a new QStash database:
   - **Name**: `intention-engine-qstash` (or any name)
   - **Region**: Choose closest to your Vercel deployment (e.g., `us-east-1`)
4. After creation, you'll see the **Overview** page with your credentials

---

## Step 2: Configure Environment Variables

### 2.1 Get QStash Credentials

From the QStash Console **Overview** page:

```
┌─────────────────────────────────────────────────────────────┐
│ QStash Credentials                                          │
├─────────────────────────────────────────────────────────────┤
│ REST URL:     https://qstash-us-east-1.upstash.io           │
│ Token:        [Click eye icon to reveal and copy]           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Get Signing Keys (for Webhook Verification)

From the QStash Console **Keys** tab:

```
┌─────────────────────────────────────────────────────────────┐
│ Signing Keys (for webhook verification)                     │
├─────────────────────────────────────────────────────────────┤
│ Current Signing Key: [base64 encoded key - click to copy]   │
│ Next Signing Key:    [base64 encoded key - click to copy]   │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Update .env File

Open your `.env` file and fill in the values:

```bash
# ------------------------------------------------------------------
# RELIABLE QUEUE (Upstash QStash) - For Saga Execution
# ------------------------------------------------------------------
QSTASH_URL="https://qstash-us-east-1.upstash.io"
QSTASH_TOKEN="your_token_here"
UPSTASH_QSTASH_TOKEN="your_token_here"  # Can be same as QSTASH_TOKEN
# Signing keys for webhook verification (from QStash Console > Keys)
QSTASH_CURRENT_SIGNING_KEY="your_current_signing_key_here"
QSTASH_NEXT_SIGNING_KEY="your_next_signing_key_here"
```

### 2.4 Quick Setup Script (Optional)

Run the automated setup script:

```bash
pnpm tsx scripts/setup-qstash.ts
```

This will interactively guide you through entering the credentials.

---

## Step 3: Verify Configuration

### 3.1 Local Development

Restart your development server:

```bash
cd apps/intention-engine
pnpm dev
```

Check the logs for initialization message:

```
[QStashService] Initialized with retry config: { retries: 3, initialBackoffMs: 1000, ... }
```

### 3.2 Test QStash Integration

Create a test execution:

```bash
# First, create an execution via your normal API
curl -X POST http://localhost:3000/api/execute \
  -H "Content-Type: application/json" \
  -d '{
    "intent": "Book a table for 2 at 7pm",
    "userId": "test-user"
  }'

# Then check logs for QStash messages:
# [ExecuteStep] QStash message sent for next step [message: <message-id>]
```

### 3.3 Verify Webhook Configuration

In QStash Console, go to **Endpoints** and verify:

- Your endpoint URL is registered: `https://your-app.vercel.app/api/engine/execute-step`
- Webhook signing is enabled

---

## Step 4: Deploy to Vercel

### 4.1 Add Environment Variables to Vercel

```bash
# Using Vercel CLI
vercel env add QSTASH_TOKEN
vercel env add QSTASH_CURRENT_SIGNING_KEY
vercel env add QSTASH_NEXT_SIGNING_KEY

# Or add them in Vercel Dashboard:
# Project Settings > Environment Variables
```

### 4.2 Redeploy

```bash
git commit -m "feat: enable QStash for reliable saga execution"
git push
vercel --prod
```

---

## Step 5: Monitor and Verify

### 5.1 Check QStash Dashboard

In QStash Console:

- **Messages**: See all triggered step executions
- **Failed Messages**: Review any failures (should be empty)
- **Dead Letter Queue**: Captures permanently failed messages

### 5.2 Monitor Vercel Logs

```bash
vercel logs --follow

# Look for:
[ExecuteStep] QStash message sent for next step [message: <id>]
[ExecuteStep] QStash webhook verified, parsing body...
[WorkflowMachine] Checkpoint saved [segment X, next step: Y]
```

### 5.3 Test Long-Running Execution

Test with a multi-step intent that exceeds 10 seconds:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Plan and execute a dinner reservation with confirmation SMS",
    "userId": "test-user"
  }'
```

**Expected behavior:**

1. Steps execute sequentially via QStash triggers
2. If execution approaches 7.5s, checkpoint is saved
3. QStash triggers next segment after 1-2 second delay
4. No 504 timeout errors

---

## Architecture Overview

### Before QStash (Unreliable)

```
┌─────────────┐     fetch(self)     ┌─────────────┐
│  Step 1     │ ──────────────────► │  Step 2     │
│  (API Route)│  ❌ Unreliable      │  (API Route)│
└─────────────┘  ❌ No retries      └─────────────┘
                 ❌ Killed by Vercel
```

### After QStash (Reliable)

```
┌─────────────┐     QStash Queue    ┌─────────────┐
│  Step 1     │ ──────────────────► │  Step 2     │
│  (API Route)│  ✅ Guaranteed      │  (API Route)│
└─────────────┘  ✅ Auto-retry      └─────────────┘
                 ✅ Dead-letter queue
```

### Execution Flow

```
1. User Request
   ↓
2. /api/execute - Creates ExecutionState in Redis
   ↓
3. /api/engine/execute-step (Step 1)
   - Executes step (< 8s)
   - Saves checkpoint if > 7.5s
   - Publishes to QStash
   ↓
4. QStash Queue
   - Holds message
   - Retries on failure (3x with backoff)
   ↓
5. /api/engine/execute-step (Step 2)
   - Triggered by QStash webhook
   - Verifies signature
   - Loads state from Redis
   - Executes next step
   ↓
6. Repeat until complete
```

---

## Troubleshooting

### QStash Not Triggering Steps

**Symptom:** Logs show "QStash not configured, using fallback fetch"

**Solution:**

1. Verify environment variables are set:
   ```bash
   echo $QSTASH_TOKEN
   echo $QSTASH_CURRENT_SIGNING_KEY
   ```

2. Restart the server after adding env vars

3. Check QStashService initialization in logs

### Webhook Signature Verification Fails

**Symptom:** `401 Unauthorized - Invalid QStash signature`

**Solution:**

1. Verify signing keys are correct (copy exactly from console)
2. Ensure `QSTASH_CURRENT_SIGNING_KEY` matches the active key
3. Set `QSTASH_NEXT_SIGNING_KEY` for key rotation
4. In development, verification is skipped if no key is set

### Steps Execute Twice (Double Execution)

**Symptom:** Same step executes multiple times

**Solution:**

1. Redis locking is already implemented (`acquireLock`)
2. Check that lock TTL is sufficient (default 30s)
3. Verify idempotency service is working

### Execution Stuck After Checkpoint

**Symptom:** Checkpoint saved but execution doesn't resume

**Solution:**

1. Check QStash Console for failed messages
2. Verify webhook endpoint is accessible (not blocked by firewall)
3. Check Ably fallback: `/api/mesh/resume` should receive `CONTINUE_EXECUTION` event

---

## Code References

Your implementation is already complete! Key files:

| File | Purpose |
|------|---------|
| `packages/shared/src/services/qstash.ts` | QStash client wrapper |
| `packages/shared/src/services/qstash-webhook.ts` | Signature verification |
| `apps/intention-engine/src/app/api/engine/execute-step/route.ts` | Step execution + QStash trigger |
| `apps/intention-engine/src/lib/engine/workflow-machine.ts` | Checkpoint/yield logic |
| `apps/intention-engine/src/lib/engine/durable-execution.ts` | Alternative durable execution |

---

## Next Steps

1. ✅ **Complete QStash setup** using this guide
2. ✅ **Test locally** with a multi-step intent
3. ✅ **Deploy to Vercel** with environment variables
4. ✅ **Monitor execution** in QStash Console
5. 🎉 **Enjoy infinite-duration sagas on Hobby tier!**

---

## Resources

- [Upstash QStash Documentation](https://upstash.com/docs/qstash)
- [QStash Console](https://console.upstash.io/qstash)
- [Vercel Hobby Tier Limits](https://vercel.com/docs/pricing#hobby)
- [Your QStash Service Implementation](../packages/shared/src/services/qstash.ts)
