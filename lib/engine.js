const fetch = require('node-fetch');
const { signPayload } = require('./hmac');
const {
  getDueEvents, tryLockEvent, updateEvent,
  createAttempt, getEventById, recoverLockedEvents
} = require('./store');

const RETRY_INTERVALS = [30_000, 300_000, 1_800_000]; // 30s, 5min, 30min
const DELIVERY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 5_000;

async function attemptDelivery(event) {
  const bodyStr = JSON.stringify({
    id: event.id,
    type: event.type,
    payload: typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
  });
  const signature = signPayload(bodyStr);

  let httpStatus = null;
  let outcome = 'failed';
  let errorMessage = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const res = await fetch(event.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event-Id': event.id,
        'X-Webhook-Event-Type': event.type,
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timer);
    httpStatus = res.status;
    if (res.ok) outcome = 'success';
    else errorMessage = `HTTP ${res.status}`;
  } catch (err) {
    errorMessage = err.name === 'AbortError' ? 'Request timed out' : err.message;
  }

  createAttempt({ event_id: event.id, http_status: httpStatus, outcome, error_message: errorMessage });
  const newCount = event.attempt_count + 1;

  if (outcome === 'success') {
    updateEvent(event.id, { status: 'delivered', attempt_count: newCount, next_attempt_at: null });
    console.log(`[Worker] Event ${event.id} DELIVERED on attempt ${newCount}`);
    return;
  }

  if (newCount > RETRY_INTERVALS.length) {
    updateEvent(event.id, { status: 'dead', attempt_count: newCount, next_attempt_at: null });
    console.log(`[Worker] Event ${event.id} → DEAD after ${newCount} attempts`);
  } else {
    const nextAt = new Date(Date.now() + RETRY_INTERVALS[newCount - 1]).toISOString();
    updateEvent(event.id, { status: 'failed', attempt_count: newCount, next_attempt_at: nextAt });
    console.log(`[Worker] Event ${event.id} failed attempt ${newCount}. Retry at ${nextAt}`);
  }
}

async function pollAndDeliver() {
  const due = getDueEvents();
  for (const event of due) {
    const locked = tryLockEvent(event.id);
    if (!locked) continue;
    attemptDelivery(event).catch(err => {
      console.error(`[Worker] Unhandled error for event ${event.id}:`, err.message);
    });
  }
}

function startDeliveryEngine() {
  recoverLockedEvents();
  console.log('[Worker] Delivery engine started (poll every 5s)');

  const loop = async () => {
    try { await pollAndDeliver(); } catch (err) { console.error('[Worker] Poll error:', err.message); }
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

function requeueEvent(eventId) {
  const ev = getEventById(eventId);
  if (!ev || ev.status !== 'dead') return false;
  updateEvent(eventId, { status: 'pending', next_attempt_at: null, attempt_count: 0 });
  return true;
}

module.exports = { startDeliveryEngine, requeueEvent };
