const express = require('express');
const path = require('path');
const { router: authRouter } = require('./api/auth');
const eventsRouter = require('./api/events');
const { startDeliveryEngine } = require('./lib/engine');
// store auto-initializes on require
require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', authRouter);
app.use('/events', eventsRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

startDeliveryEngine();

app.listen(PORT, () => {
  console.log(`[Server] WebhookForge running on http://localhost:${PORT}`);
});

module.exports = app;
