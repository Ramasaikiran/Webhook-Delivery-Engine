const express = require('express');
const { requireAuth } = require('./auth');
const {
  getEvents, getEventById, createEvent,
  updateEvent, getAttempts, requeueDead
} = require('../lib/store');
const { requeueEvent } = require('../lib/engine');

const router = express.Router();
router.use(requireAuth);

function formatEvent(ev) {
  const attempts = getAttempts(ev.id);
  return {
    id: ev.id,
    type: ev.type,
    payload: typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload,
    webhook_url: ev.webhook_url,
    status: ev.status,
    created_at: ev.created_at,
    next_attempt_at: (ev.next_attempt_at === 'LOCKED') ? null : ev.next_attempt_at,
    attempt_count: ev.attempt_count,
    attempts: attempts.map(a => ({
      attempted_at: a.attempted_at,
      http_status: a.http_status,
      outcome: a.outcome,
      error_message: a.error_message || undefined,
    })),
  };
}

router.post('/', (req, res) => {
  const { type, payload, webhook_url } = req.body || {};
  if (!type || typeof type !== 'string' || !type.trim())
    return res.status(400).json({ error: '"type" is required' });
  if (payload === undefined || payload === null)
    return res.status(400).json({ error: '"payload" is required' });
  if (!webhook_url || typeof webhook_url !== 'string')
    return res.status(400).json({ error: '"webhook_url" is required' });
  try { new URL(webhook_url); } catch { return res.status(400).json({ error: '"webhook_url" must be a valid URL' }); }

  try {
    const ev = createEvent({ type: type.trim(), payload, webhook_url, user_id: req.user.userId });
    return res.status(201).json(formatEvent(ev));
  } catch (err) {
    console.error('[Events] Create error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  if (status) {
    const valid = ['pending', 'delivered', 'failed', 'dead'];
    if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }
  const evs = getEvents({ userId: req.user.userId, status, limit: Math.min(Number(limit) || 50, 200), offset: Number(offset) || 0 });
  return res.json(evs.map(formatEvent));
});

router.get('/:id', (req, res) => {
  const ev = getEventById(req.params.id);
  if (!ev || ev.user_id !== req.user.userId) return res.status(404).json({ error: 'Event not found' });
  return res.json(formatEvent(ev));
});

router.post('/:id/retry', (req, res) => {
  const ev = getEventById(req.params.id);
  if (!ev || ev.user_id !== req.user.userId) return res.status(404).json({ error: 'Event not found' });
  if (ev.status !== 'dead') return res.status(400).json({ error: 'Only dead events can be manually retried', current_status: ev.status });
  const requeued = requeueEvent(req.params.id);
  if (!requeued) return res.status(400).json({ error: 'Event could not be re-queued' });
  const updated = getEventById(req.params.id);
  return res.json({ message: 'Event re-queued for delivery', event: formatEvent(updated) });
});

module.exports = router;
