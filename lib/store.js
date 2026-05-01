const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.json');

// In-memory store
let store = {
  users: [],
  events: [],
  attempts: [],
};

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      store = JSON.parse(raw);
      // Ensure all tables exist
      if (!store.users) store.users = [];
      if (!store.events) store.events = [];
      if (!store.attempts) store.attempts = [];
    }
  } catch (e) {
    console.error('[DB] Failed to load store:', e.message);
  }
  seed();
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('[DB] Failed to save store:', e.message);
  }
}

function seed() {
  const exists = store.users.find(u => u.email === 'demo@nestack.com');
  if (!exists) {
    store.users.push({
      id: uuidv4(),
      email: 'demo@nestack.com',
      password_hash: bcrypt.hashSync('demo1234', 10),
      created_at: new Date().toISOString(),
    });
    save();
    console.log('[DB] Seeded default user: demo@nestack.com / demo1234');
  }
}

// ── Users ─────────────────────────────────────────────
function getUserByEmail(email) {
  return store.users.find(u => u.email === email.toLowerCase()) || null;
}

function getUserById(id) {
  return store.users.find(u => u.id === id) || null;
}

function createUser({ email, password_hash }) {
  const user = {
    id: uuidv4(),
    email: email.toLowerCase(),
    password_hash,
    created_at: new Date().toISOString(),
  };
  store.users.push(user);
  save();
  return user;
}

// ── Events ────────────────────────────────────────────
function getEvents({ userId, status, limit = 50, offset = 0 }) {
  let evs = store.events.filter(e => e.user_id === userId);
  if (status) evs = evs.filter(e => e.status === status);
  evs = evs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return evs.slice(offset, offset + limit);
}

function getEventById(id) {
  return store.events.find(e => e.id === id) || null;
}

function createEvent({ type, payload, webhook_url, user_id }) {
  const event = {
    id: uuidv4(),
    type,
    payload: JSON.stringify(payload),
    webhook_url,
    status: 'pending',
    created_at: new Date().toISOString(),
    next_attempt_at: null,
    attempt_count: 0,
    user_id,
  };
  store.events.push(event);
  save();
  return event;
}

function updateEvent(id, fields) {
  const ev = store.events.find(e => e.id === id);
  if (!ev) return false;
  Object.assign(ev, fields);
  save();
  return true;
}

// ── Attempts ──────────────────────────────────────────
function getAttempts(event_id) {
  return store.attempts
    .filter(a => a.event_id === event_id)
    .sort((a, b) => new Date(a.attempted_at) - new Date(b.attempted_at));
}

function createAttempt({ event_id, http_status, outcome, error_message }) {
  const attempt = {
    id: uuidv4(),
    event_id,
    attempted_at: new Date().toISOString(),
    http_status: http_status ?? null,
    outcome,
    error_message: error_message || null,
  };
  store.attempts.push(attempt);
  save();
  return attempt;
}

// ── Due events for delivery ───────────────────────────
function getDueEvents() {
  const now = new Date();
  return store.events.filter(e => {
    if (e.status === 'pending' && !e.next_attempt_at) return true;
    if (e.status === 'failed' && e.next_attempt_at && e.next_attempt_at !== 'LOCKED') {
      return new Date(e.next_attempt_at) <= now;
    }
    return false;
  });
}

function tryLockEvent(id) {
  const ev = store.events.find(e => e.id === id);
  if (!ev) return false;
  // Only lock if still in a lockable state
  if (ev.status === 'pending' && !ev.next_attempt_at) {
    ev.next_attempt_at = 'LOCKED';
    save();
    return true;
  }
  if (ev.status === 'failed' && ev.next_attempt_at && ev.next_attempt_at !== 'LOCKED') {
    const due = new Date(ev.next_attempt_at) <= new Date();
    if (due) {
      ev.next_attempt_at = 'LOCKED';
      save();
      return true;
    }
  }
  return false;
}

function recoverLockedEvents() {
  const soon = new Date(Date.now() + 30_000).toISOString();
  let count = 0;
  store.events.forEach(e => {
    if ((e.status === 'pending' || e.status === 'failed') && e.next_attempt_at === 'LOCKED') {
      e.next_attempt_at = e.status === 'pending' ? null : soon;
      count++;
    }
  });
  if (count > 0) {
    save();
    console.log(`[DB] Recovered ${count} locked event(s) from previous run`);
  }
}

load();

module.exports = {
  getUserByEmail,
  getUserById,
  createUser,
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  getAttempts,
  createAttempt,
  getDueEvents,
  tryLockEvent,
  recoverLockedEvents,
};
