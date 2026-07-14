const { redisConfigured } = require('./_lib/redis');
const { sessionConfigReady } = require('./_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    ok: true,
    databaseConfigured: redisConfigured(),
    adminConfigured: sessionConfigReady(),
    time: new Date().toISOString(),
  });
};
