const {
  parseCookies,
  COOKIE_NAME,
  verifySessionToken,
  sessionConfigReady,
} = require('../_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!sessionConfigReady()) {
    return res.status(200).json({
      authenticated: false,
      configured: false,
    });
  }

  const token = parseCookies(req)[COOKIE_NAME];
  const session = verifySessionToken(token);

  return res.status(200).json({
    authenticated: Boolean(session),
    configured: true,
    expiresAt: session ? new Date(session.exp * 1000).toISOString() : null,
  });
};
