const { redisConfigured } = require('../_lib/redis');
const { cleanupExpiredEvents } = require('../_lib/events');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!redisConfigured()) {
    return res.status(500).json({ error: 'Base de données non configurée' });
  }

  const configuredSecret = process.env.CRON_SECRET || '';
  const authorization = String(req.headers.authorization || '');
  if (
    !configuredSecret ||
    authorization !== `Bearer ${configuredSecret}`
  ) {
    return res.status(401).json({ error: 'Accès refusé' });
  }

  try {
    const result = await cleanupExpiredEvents();
    return res.status(200).json({
      ok: true,
      ...result,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : 'Erreur serveur',
    });
  }
};
