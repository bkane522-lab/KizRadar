const {
  clearSessionCookie,
  assertSameOrigin,
} = require('../_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!assertSameOrigin(req)) {
    return res.status(403).json({ error: 'Origine de la requête refusée' });
  }

  res.setHeader('Set-Cookie', clearSessionCookie(req));
  return res.status(200).json({ authenticated: false });
};
