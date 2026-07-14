const { redisConfigured, redis } = require('../_lib/redis');
const {
  ALLOWED_STATUSES,
  validateEventInput,
  normalizeStoredEvent,
  isExpired,
  getEvent,
  saveEvent,
  deleteEvent,
  loadAllEvents,
  cleanupExpiredEvents,
} = require('../_lib/events');
const {
  requireAdmin,
  assertSameOrigin,
} = require('../_lib/security');

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

function computeStats(events) {
  return events.reduce(
    (stats, event) => {
      if (event._deleted) return stats;
      stats.total += 1;
      if (stats[event.status] !== undefined) stats[event.status] += 1;
      if (isExpired(event)) stats.expired += 1;
      return stats;
    },
    {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      archived: 0,
      expired: 0,
    }
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!redisConfigured()) {
    return res.status(500).json({ error: 'Base de données non configurée' });
  }

  const session = requireAdmin(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const events = await loadAllEvents({ cleanup: true });
      const visibleEvents = events
        .filter((event) => !event._deleted)
        .sort(
          (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
        );

      return res.status(200).json({
        events: visibleEvents,
        stats: computeStats(visibleEvents),
        generatedAt: new Date().toISOString(),
      });
    }

    if (!assertSameOrigin(req)) {
      return res.status(403).json({ error: 'Origine de la requête refusée' });
    }

    if (req.method === 'DELETE') {
      const body = readBody(req);
      const id = String(body.id || (req.query && req.query.id) || '');
      if (!id) return res.status(400).json({ error: 'Identifiant manquant' });

      const event = await getEvent(id);
      if (!event) return res.status(404).json({ error: 'Événement introuvable' });

      await deleteEvent(id, event);
      return res.status(200).json({ deleted: id });
    }

    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'GET, PATCH, DELETE');
      return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    const body = readBody(req);
    const id = String(body.id || '');
    const action = String(body.action || '');

    if (!id) return res.status(400).json({ error: 'Identifiant manquant' });

    const current = await getEvent(id);
    if (!current) return res.status(404).json({ error: 'Événement introuvable' });

    const now = new Date().toISOString();
    let updated = { ...current };

    if (action === 'approve') {
      if (isExpired(current)) {
        return res.status(400).json({
          error: 'Impossible d’approuver un événement déjà terminé',
        });
      }
      updated.status = 'approved';
      updated.approvedAt = now;
      updated.rejectedAt = '';
      updated.archivedAt = '';
    } else if (action === 'reject') {
      updated.status = 'rejected';
      updated.rejectedAt = now;
    } else if (action === 'archive') {
      updated.status = 'archived';
      updated.archivedAt = now;
    } else if (action === 'restore') {
      if (isExpired(current)) {
        return res.status(400).json({
          error: 'Modifie d’abord les dates avant de restaurer cet événement',
        });
      }
      updated.status = 'approved';
      updated.archivedAt = '';
      updated.approvedAt = updated.approvedAt || now;
    } else if (action === 'update') {
      const merged = {
        ...current,
        ...(body.event || {}),
      };
      const validated = validateEventInput(merged, {
        allowExpired: body.allowExpired === true,
      });
      updated = {
        ...current,
        ...validated,
      };

      if (
        body.event &&
        body.event.status &&
        ALLOWED_STATUSES.includes(body.event.status)
      ) {
        updated.status = body.event.status;
      }
    } else {
      return res.status(400).json({ error: 'Action administrateur inconnue' });
    }

    updated.updatedAt = now;
    updated = normalizeStoredEvent(updated, id);
    await saveEvent(updated);

    return res.status(200).json({ event: updated });
  } catch (error) {
    const message = error && error.message ? error.message : 'Erreur serveur';
    const status = /obligatoire|invalide|terminé|après|dépasse|éloignée/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ error: message });
  }
};
