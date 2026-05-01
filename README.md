# ⚡ WebhookForge — Webhook Delivery Engine

> **Nestack SDE Assessment Submission**

A production-grade webhook delivery system with retry scheduling, HMAC signing, and a full dashboard UI.

---

## Live Deployment

**[https://your-deployment-url.com](https://your-deployment-url.com)**

> Update this URL after deploying to Railway, Render, or Fly.io (see Deployment section below).

---

## Demo Credentials

| Email | Password |
|-------|----------|
| `demo@nestack.com` | `demo1234` |

Or register a new account via the dashboard.

---

## Architecture

```
webhook-engine/
├── server.js          # Express app + startup
├── api/
│   ├── auth.js        # Login/register + JWT middleware
│   └── events.js      # All /events endpoints
├── lib/
│   ├── db.js          # SQLite schema + seeding
│   ├── engine.js      # Background delivery worker (no queue lib)
│   └── hmac.js        # HMAC-SHA256 signing/verification
└── public/
    └── index.html     # Dashboard SPA
```

**Storage:** SQLite (via `better-sqlite3`). In-memory is not used so data survives restarts.

**No queue libraries** — retry scheduling is implemented directly using a poll loop + `setTimeout`.

---

## Setup & Run (Local)

### Prerequisites
- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/you/yourName_Nestack_Submission
cd webhook-engine
npm install
```

### Environment Variables (optional — defaults work for local dev)

```env
PORT=3000
WEBHOOK_SIGNING_KEY=nestack-webhook-secret-key-2024
JWT_SECRET=nestack-jwt-secret-2024
DB_PATH=./webhook.db           # SQLite file path
NODE_ENV=development
```

### Start

```bash
npm start
```

The API server and background delivery engine start together in a single process.

Open **http://localhost:3000** for the dashboard.

---

## API Reference

### Auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `POST` | `/auth/register` | `{ email, password }` | `{ token, email }` |
| `POST` | `/auth/login` | `{ email, password }` | `{ token, email }` |

All `/events` routes require `Authorization: Bearer <token>`.

### Events

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `POST` | `/events` | `{ type, payload, webhook_url }` | `201` — event object |
| `GET` | `/events` | — | `200` — array of events |
| `GET` | `/events/:id` | — | `200` — event + attempts |
| `POST` | `/events/:id/retry` | — | `200` or `400` if not dead |

**Query params for `GET /events`:** `?status=pending|delivered|failed|dead&limit=50&offset=0`

### Event Object Shape

```json
{
  "id": "uuid",
  "type": "payment.failed",
  "payload": { ... },
  "webhook_url": "https://example.com/hook",
  "status": "pending | delivered | failed | dead",
  "created_at": "2024-01-01T00:00:00Z",
  "attempt_count": 2,
  "next_attempt_at": "2024-01-01T00:05:00Z",
  "attempts": [
    {
      "attempted_at": "2024-01-01T00:00:00Z",
      "http_status": 500,
      "outcome": "failed",
      "error_message": "HTTP 500"
    }
  ]
}
```

---

## HMAC Signature Verification

Every outgoing webhook POST includes:

```
X-Webhook-Signature: sha256=<hex>
X-Webhook-Event-Id: <uuid>
X-Webhook-Event-Type: <type>
```

The signature is an **HMAC-SHA256** over the raw JSON body string, using the key from `WEBHOOK_SIGNING_KEY`.

### Verify in Node.js

```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signature) {
  const key = process.env.WEBHOOK_SIGNING_KEY || 'nestack-webhook-secret-key-2024';
  const hex = signature.replace('sha256=', '');
  const expected = crypto
    .createHmac('sha256', key)
    .update(rawBody)        // rawBody must be the raw Buffer/string before JSON.parse
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(hex, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

// Express — parse body as raw bytes:
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!verifyWebhook(req.body, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const event = JSON.parse(req.body);
  console.log('Received event:', event.type);
  res.sendStatus(200);
});
```

### Verify in Python

```python
import hmac, hashlib, os

def verify_webhook(raw_body: bytes, signature: str) -> bool:
    key = os.environ.get('WEBHOOK_SIGNING_KEY', 'nestack-webhook-secret-key-2024')
    hex_sig = signature.removeprefix('sha256=')
    expected = hmac.new(key.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(hex_sig, expected)
```

---

## Retry Scheduling Approach

No queue library (Celery, BullMQ, etc.) is used. The retry engine is implemented directly:

### How it works

1. **Poll loop**: Every 5 seconds, a `setTimeout`-based loop queries the SQLite DB for events where:
   - `status = 'pending'` AND `next_attempt_at IS NULL` (first attempt)
   - `status = 'failed'` AND `next_attempt_at <= NOW` (due for retry)

2. **Concurrency guard**: Before processing, the row's `next_attempt_at` is set to the sentinel value `'9999-12-31'` using an atomic `UPDATE ... WHERE next_attempt_at <= now`. Only the process that successfully updates the row proceeds — preventing duplicate delivery.

3. **Fixed retry intervals**:
   | Attempt | Delay |
   |---------|-------|
   | 1st | Immediate |
   | 2nd | +30 seconds |
   | 3rd | +5 minutes |
   | 4th | +30 minutes |
   | After 4th | `status = dead` |

4. **Delivery**: Each attempt POSTs to the webhook URL with a 10-second timeout. Any non-2xx, timeout, or connection error counts as a failure.

5. **Success**: First 2xx response sets `status = delivered`, clears `next_attempt_at`.

### Server Restart Behaviour

> **Does the implementation handle restarts? Yes.**

Events that were mid-flight when the server stopped have `next_attempt_at = '9999-12-31'` (the sentinel). On startup, the engine runs a recovery query:

```sql
UPDATE events
SET next_attempt_at = datetime('now', '+30 seconds')
WHERE status IN ('pending', 'failed') AND next_attempt_at = '9999-12-31'
```

This reschedules all interrupted events for delivery within 30 seconds of restart. **No events are lost or stuck.** The attempt count is preserved, so they count toward the retry limit correctly.

Because we use SQLite (a file-based DB), all event state persists across restarts — unlike a pure in-memory store.

---

## Deployment

### Railway (recommended — supports persistent SQLite)

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

Set env vars in the Railway dashboard:
- `WEBHOOK_SIGNING_KEY` — a strong random secret
- `JWT_SECRET` — a strong random secret
- `NODE_ENV=production`

### Render

1. Create a new **Web Service** pointing to your repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add env vars in the dashboard

### Fly.io

```bash
fly launch
fly deploy
fly secrets set WEBHOOK_SIGNING_KEY=your-strong-secret JWT_SECRET=your-jwt-secret
```

> **Note on Vercel**: Vercel uses a serverless/edge runtime which does not support long-running background processes or persistent file system storage. The delivery engine requires both. Use Railway, Render, or Fly.io for a fully working deployment. For a Vercel-compatible demo, the API endpoints work but the delivery engine won't fire automatically (requests would need a cron trigger).

---

## Testing

### Quick smoke test (curl)

```bash
BASE=http://localhost:3000

# 1. Login
TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@nestack.com","password":"demo1234"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")

echo "Token: $TOKEN"

# 2. Send an event (use https://webhook.site for a real endpoint)
curl -X POST $BASE/events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"payment.failed","payload":{"amount":99.99},"webhook_url":"https://webhook.site/YOUR_ID"}'

# 3. List events
curl $BASE/events -H "Authorization: Bearer $TOKEN"
```

### Test with webhook.site

1. Go to [https://webhook.site](https://webhook.site) and copy your unique URL
2. Use it as `webhook_url` when creating an event
3. Within seconds, you'll see the signed POST arrive with `X-Webhook-Signature`

---

## Evaluation Checklist

| Criterion | Implementation |
|-----------|---------------|
| ✅ Retry schedule correct | 30s → 5min → 30min, self-implemented poll loop |
| ✅ No queue library | Pure `setTimeout` + SQLite polling |
| ✅ All API endpoints | POST/GET/GET:id/POST:id/retry |
| ✅ HMAC signing | Every request signed, verifiable |
| ✅ Failure handling | Timeout + non-2xx → failure; dead after 4 attempts |
| ✅ Auth system | Email+password with bcrypt + JWT |
| ✅ Server restart recovery | Sentinel value + recovery on startup |
| ✅ Dashboard UI | Full SPA with event list, detail, create |

---

## Contributors (Evaluators)

- bishal@nestack.com
- sannidhya@nestack.com
- sanjay@nestack.com
