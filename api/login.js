const { redisConfigured, redis } = require('../_lib/redis');
const {
  safeEqual,
  sessionConfigReady,
  createSessionToken,
  makeSessionCookie,
  hashedIp,
  consumeRateLimit,
  assertSameOrigin,
} = require('../_lib/security');

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!assertSameOrigin(req)) {
    return res.status(403).json({ error: 'Origine de la requête refusée' });
  }

  if (!redisConfigured()) {
    return res.status(500).json({ error: 'Base de données non configurée' });
  }

  if (!sessionConfigReady()) {
    return res.status(500).json({
      error:
        'ADMIN_PASSWORD ou ADMIN_SESSION_SECRET absent. Le secret doit contenir au moins 32 caractères.',
    });
  }

  try {
    const key = `kizradar:rate:login:${hashedIp(req)}`;
    const rate = await consumeRateLimit(key, 10, 900);

    if (!rate.allowed) {
      return res.status(429).json({
        error: 'Trop de tentatives. Réessaie dans quelques minutes.',
      });
    }

    const body = readBody(req);
    if (!safeEqual(body.password || '', process.env.ADMIN_PASSWORD)) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    await redis(['DEL', key]);
    const token = createSessionToken();
    res.setHeader('Set-Cookie', makeSessionCookie(req, token));

    return res.status(200).json({ authenticated: true });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : 'Erreur serveur',
    });
  }
};
