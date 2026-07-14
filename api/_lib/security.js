const crypto = require('crypto');
const { redis } = require('./redis');

const COOKIE_NAME = 'kizradar_admin';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(hash(left), hash(right));
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url');
}

function parseCookies(req) {
  const header = String((req.headers && req.headers.cookie) || '');
  const cookies = {};

  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function sessionConfigReady() {
  return Boolean(
    process.env.ADMIN_PASSWORD &&
    process.env.ADMIN_SESSION_SECRET &&
    process.env.ADMIN_SESSION_SECRET.length >= 32
  );
}

function createSessionToken() {
  const secret = process.env.ADMIN_SESSION_SECRET || '';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + SESSION_DURATION_SECONDS,
    nonce: crypto.randomBytes(18).toString('hex'),
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifySessionToken(token) {
  if (!sessionConfigReady() || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expected = sign(encoded, process.env.ADMIN_SESSION_SECRET);

  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    );
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function isHttps(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '');
  return forwarded === 'https' || Boolean(req.connection && req.connection.encrypted);
}

function makeSessionCookie(req, token, maxAge = SESSION_DURATION_SECONDS) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];

  if (isHttps(req) || process.env.VERCEL) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie(req) {
  return makeSessionCookie(req, '', 0);
}

function requireAdmin(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = verifySessionToken(token);

  if (!session) {
    res.status(401).json({ error: 'Session administrateur requise' });
    return null;
  }

  return session;
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  return (
    forwarded.split(',')[0].trim() ||
    String(req.headers['x-real-ip'] || '') ||
    'unknown'
  );
}

function hashedIp(req) {
  return crypto
    .createHash('sha256')
    .update(requestIp(req))
    .digest('hex')
    .slice(0, 32);
}

function assertSameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function consumeRateLimit(key, limit, windowSeconds) {
  const count = Number(await redis(['INCR', key])) || 0;
  if (count === 1) await redis(['EXPIRE', key, String(windowSeconds)]);
  return {
    allowed: count <= limit,
    count,
    remaining: Math.max(0, limit - count),
  };
}

module.exports = {
  COOKIE_NAME,
  SESSION_DURATION_SECONDS,
  safeEqual,
  sessionConfigReady,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  makeSessionCookie,
  clearSessionCookie,
  requireAdmin,
  requestIp,
  hashedIp,
  assertSameOrigin,
  consumeRateLimit,
};
