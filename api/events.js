// ════════════════════════════════════════════════
// /api/events.js — KizRadar
// Stockage communautaire (Upstash Redis REST)
// Compteur "J'y vais" atomique via HINCRBY + gestion d'erreurs robuste
// ════════════════════════════════════════════════

const URL_BASE = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN    = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const EVENTS_KEY = 'kizradar:events'; // hash : id -> métadonnées JSON (sans le compteur)
const GOING_KEY  = 'kizradar:going';  // hash : id -> compteur entier (source de vérité)
const ALLOWED_STYLES = ['Kizomba', 'Urban Kiz', 'Semba', 'Tarraxo', 'SBK'];
const REDIS_TIMEOUT = 8000;

// ── Appel Redis brut avec timeout ──
async function redisRaw(body, endpoint = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REDIS_TIMEOUT);
  let r;
  try {
    r = await fetch(URL_BASE + endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Base de données injoignable (timeout)' : 'Erreur réseau base de données');
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (_) { throw new Error('Réponse invalide de la base de données'); }
  return j;
}

// Commande unique -> renvoie le résultat
async function redis(cmd) {
  const j = await redisRaw(cmd);
  if (j && j.error) throw new Error(j.error);
  return j ? j.result : null;
}

// Pipeline (plusieurs commandes en un aller-retour)
async function pipeline(cmds) {
  const arr = await redisRaw(cmds, '/pipeline');
  if (arr && arr.error) throw new Error(arr.error);
  if (!Array.isArray(arr)) throw new Error('Réponse pipeline invalide');
  return arr.map(x => {
    if (x && x.error) throw new Error(x.error);
    return x ? x.result : null;
  });
}

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function parseHash(flat) {
  // Upstash HGETALL -> [field, value, field, value, ...]
  const map = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
  }
  return map;
}

// ── Événements de démarrage (à retirer quand la communauté publie) ──
const SEED = [
  { id: 1, title: "Soirée Kizomba du Vendredi", loc: "Paris 11e", lat: 48.857, lng: 2.380, date: todayISO(0), dj: "DJ Madiss", price: "10€", style: "Kizomba", desc: "Ambiance chaleureuse, cours débutant 20h puis soirée libre.", going: 12 },
  { id: 2, title: "Urban Kiz Night", loc: "Lyon Centre", lat: 45.764, lng: 4.835, date: todayISO(0), dj: "DJ Ash", price: "12€", style: "Urban Kiz", desc: "Le rendez-vous mensuel Urban Kiz de Lyon.", going: 8 },
  { id: 3, title: "Semba Festif Weekend", loc: "Bruxelles", lat: 50.850, lng: 4.351, date: todayISO(2), dj: "DJ Znobia", price: "Gratuit", style: "Semba", desc: "Soirée 100% Semba avant le weekend.", going: 21 },
  { id: 4, title: "SBK Saturday", loc: "Genève", lat: 46.204, lng: 6.143, date: todayISO(1), dj: "DJ Neyser", price: "15€", style: "SBK", desc: "Salsa Bachata Kizomba — 3 salles, 3 ambiances.", going: 34 },
  { id: 5, title: "Tarraxo Sunset", loc: "Marseille", lat: 43.296, lng: 5.370, date: todayISO(3), dj: "—", price: "8€", style: "Tarraxo", desc: "Soirée intimiste en bord de mer.", going: 6 },
];

async function seedIfEmpty() {
  const evCmd = ['HSET', EVENTS_KEY];
  const goCmd = ['HSET', GOING_KEY];
  SEED.forEach(ev => {
    const { going, ...meta } = ev;
    evCmd.push(String(ev.id), JSON.stringify(meta));
    goCmd.push(String(ev.id), String(going));
  });
  await pipeline([evCmd, goCmd]);
  return SEED;
}

async function listEvents() {
  const [evFlat, goFlat] = await pipeline([
    ['HGETALL', EVENTS_KEY],
    ['HGETALL', GOING_KEY]
  ]);
  const evMap = parseHash(evFlat);
  const goMap = parseHash(goFlat);
  const list = [];
  for (const id in evMap) {
    try {
      const ev = JSON.parse(evMap[id]);
      ev.going = parseInt(goMap[id], 10) || 0;
      list.push(ev);
    } catch (_) {}
  }
  return list;
}

module.exports = async (req, res) => {
  if (!URL_BASE || !TOKEN) {
    res.status(500).json({ error: 'Base de données non configurée (variables KV manquantes)' });
    return;
  }

  try {
    // ── LISTE ──
    if (req.method === 'GET') {
      let list = await listEvents();
      if (list.length === 0) list = await seedIfEmpty();
      res.status(200).json({ events: list });
      return;
    }

    // ── ACTIONS ──
    if (req.method === 'POST') {
      let body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
      catch (_) { res.status(400).json({ error: 'Requête invalide' }); return; }

      const action = body.action;

      // Ajouter une soirée
      if (action === 'add') {
        const e = body.event || {};
        if (!e.title || !e.loc || !e.date || !e.style ||
            typeof e.lat !== 'number' || typeof e.lng !== 'number' ||
            isNaN(e.lat) || isNaN(e.lng)) {
          res.status(400).json({ error: 'Champs obligatoires manquants ou invalides' });
          return;
        }
        if (!ALLOWED_STYLES.includes(e.style)) {
          res.status(400).json({ error: 'Style invalide' });
          return;
        }
        const id = Date.now();
        const meta = {
          id,
          title: clean(e.title, 80),
          loc:   clean(e.loc, 120),
          lat:   e.lat,
          lng:   e.lng,
          date:  clean(e.date, 10),
          dj:    clean(e.dj, 60),
          price: clean(e.price, 30),
          style: e.style,
          desc:  clean(e.desc, 300)
        };
        await pipeline([
          ['HSET', EVENTS_KEY, String(id), JSON.stringify(meta)],
          ['HSET', GOING_KEY, String(id), '1']
        ]);
        res.status(200).json({ event: { ...meta, going: 1 } });
        return;
      }

      // Toggle "J'y vais" — ATOMIQUE
      if (action === 'going') {
        const id = String(body.id || '');
        const delta = body.delta === -1 ? -1 : 1;
        if (!id) { res.status(400).json({ error: 'Identifiant manquant' }); return; }

        const exists = await redis(['HEXISTS', EVENTS_KEY, id]);
        if (!exists) { res.status(404).json({ error: 'Soirée introuvable' }); return; }

        let count = await redis(['HINCRBY', GOING_KEY, id, delta]); // atomique
        if (typeof count !== 'number') count = parseInt(count, 10) || 0;
        if (count < 0) { await redis(['HSET', GOING_KEY, id, '0']); count = 0; }

        res.status(200).json({ going: count });
        return;
      }

      res.status(400).json({ error: 'Action inconnue' });
      return;
    }

    res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
