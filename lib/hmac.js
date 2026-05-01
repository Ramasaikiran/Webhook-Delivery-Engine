const crypto = require('crypto');

const SIGNING_KEY = process.env.WEBHOOK_SIGNING_KEY || 'nestack-webhook-secret-key-2024';

/**
 * Signs a payload with HMAC-SHA256.
 * The signature is computed over the raw JSON string of the request body.
 */
function signPayload(body) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto
    .createHmac('sha256', SIGNING_KEY)
    .update(bodyStr)
    .digest('hex');
}

/**
 * Verifies an incoming signature against the expected one.
 */
function verifySignature(rawBody, signature) {
  const expected = signPayload(rawBody);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = { signPayload, verifySignature, SIGNING_KEY };
