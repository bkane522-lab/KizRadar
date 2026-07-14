const crypto = require('crypto');
const { redisConfigured, redis, pipeline } = require('./_lib/redis');
const {
  EVENTS_KEY,
  GOING_KEY,
  DEDUPE_KEY,
  validateEventInput,
  fingerprintFor,
  isExpired,
  publicEvent,
  getEvent,
  loadAllEvents,
  sortEvents,
} = require('./_lib/events');
const {
  hashedIp,
  consumeRateLimit,
} = require('./_lib/security');

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('Requête JSON invalide');
    }
  }
  return req.body;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

module.exports = async function handler(req, res) {
  noStore(res);

  if (!redisConfigured()) {
    return res.status(500).json({
      error: 'Base de données non configurée',
      code: 'DATABASE_NOT_CONFIGURED',
    });
  }

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const allEvents = await loadAllEvents({ cleanup: true });
      const visible = sortEvents(
        allEvents.filter(
          (event) =>
            !event._deleted &&
            event.status === 'approved' &&
            !isExpired(event)
        )
      );

      return res.status(200).json({
        events: visible.map((event) => publicEvent(event, event.going)),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    const body = readBody(req);
    const action = body.action || 'add';

    if (action === 'going') {
      const rate = await consumeRateLimit(
        `kizradar:rate:going:${hashedIp(req)}`,
        40,
        3600
      );
      if (!rate.allowed) {
        return res.status(429).json({
          error: 'Trop de tentatives. Réessaie plus tard.',
        });
      }

      const id = String(body.id || '');
      const delta = body.delta === -1 ? -1 : 1;
      if (!id) return res.status(400).json({ error: 'Identifiant manquant' });

      const event = await getEvent(id);
      if (!event || event.status !== 'approved' || isExpired(event)) {
        return res.status(404).json({ error: 'Événement introuvable' });
      }

      let count = Number(await redis(['HINCRBY', GOING_KEY, id, String(delta)]));
      if (!Number.isFinite(count)) count = 0;
      if (count < 0) {
        await redis(['HSET', GOING_KEY, id, '0']);
        count = 0;
      }

      return res.status(200).json({ going: count });
    }

    if (action !== 'add') {
      return res.status(400).json({ error: 'Action inconnue' });
    }

    const eventInput = body.event || {};
    if (String(eventInput.website || '').trim()) {
      return res.status(202).json({
        pending: true,
        message: 'Événement envoyé. Il sera publié après vérification.',
      });
    }

    const rate = await consumeRateLimit(
      `kizradar:rate:submit:${hashedIp(req)}`,
      5,
      3600
    );
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));

    if (!rate.allowed) {
      return res.status(429).json({
        error: 'Limite atteinte : 5 propositions maximum par heure.',
      });
    }

    const validated = validateEventInput(eventInput);
    const fingerprint = fingerprintFor(validated);
    const duplicateId = await redis(['HGET', DEDUPE_KEY, fingerprint]);

    if (duplicateId) {
      const duplicate = await getEvent(duplicateId);
      if (duplicate && !['rejected', 'archived'].includes(duplicate.status)) {
        return res.status(409).json({
          error: 'Cet événement semble déjà avoir été proposé.',
        });
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const event = {
      id,
      ...validated,
      status: 'pending',
      source: 'community',
      fingerprint,
      createdAt: now,
      updatedAt: now,
      approvedAt: '',
      rejectedAt: '',
      archivedAt: '',
      submittedFrom: hashedIp(req),
    };

    await pipeline([
      ['HSET', EVENTS_KEY, id, JSON.stringify(event)],
      ['HSET', GOING_KEY, id, '0'],
      ['HSET', DEDUPE_KEY, fingerprint, id],
    ]);

    return res.status(202).json({
      pending: true,
      id,
      message: 'Événement envoyé. Il sera publié après vérification.',
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Erreur serveur';
    const clientErrorPatterns = [
      'obligatoire',
      'invalide',
      'trop court',
      'déjà terminé',
      'après',
      'dépasse',
      'éloignée',
    ];
    const status = clientErrorPatterns.some((part) => message.includes(part))
      ? 400
      : 500;

    return res.status(status).json({ error: message });
  }
};
