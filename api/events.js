const crypto = require('crypto');
const { redis, pipeline, parseHash } = require('./redis');

const EVENTS_KEY = 'kizradar:events';
const GOING_KEY = 'kizradar:going';
const DEDUPE_KEY = 'kizradar:dedupe';

const ALLOWED_STYLES = [
  'Kizomba',
  'Urban Kiz',
  'Semba',
  'Tarraxo',
  'SBK',
  'Bachata',
  'Festival',
  'Workshop',
];

const ALLOWED_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'archived',
];

const ARCHIVE_RETENTION_DAYS = Math.max(
  1,
  Math.min(365, Number(process.env.ARCHIVE_RETENTION_DAYS || 7))
);

function cleanString(value, maxLength = 200) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 1000) {
  return String(value == null ? '' : value)
    .replace(/\r/g, '')
    .trim()
    .slice(0, maxLength);
}

function cleanEmail(value) {
  const email = cleanString(value, 180).toLowerCase();
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanUrl(value) {
  const raw = cleanString(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function dateOnlyToIso(value, isEnd = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return `${value}T${isEnd ? '23:59:59.999' : '18:00:00.000'}Z`;
}

function toIso(value, isEnd = false) {
  if (!value) return '';
  const text = String(value).trim();
  const dateOnly = dateOnlyToIso(text, isEnd);
  if (dateOnly) return dateOnly;

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeStatus(value) {
  return ALLOWED_STATUSES.includes(value) ? value : 'approved';
}

function normalizeStoredEvent(raw, fallbackId = '') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = cleanString(source.id || fallbackId, 100);
  const startAt = toIso(source.startAt || source.date, false);
  let endAt = toIso(source.endAt || source.date, true);

  if (!endAt && startAt) {
    const fallback = new Date(startAt);
    fallback.setHours(fallback.getHours() + 8);
    endAt = fallback.toISOString();
  }

  const location = cleanString(
    source.location || source.address || source.loc,
    180
  );

  return {
    id,
    title: cleanString(source.title, 100),
    style: ALLOWED_STYLES.includes(source.style)
      ? source.style
      : 'Kizomba',
    city: cleanString(source.city, 100),
    location,
    address: cleanString(source.address || location, 180),
    lat: toNumber(source.lat),
    lng: toNumber(source.lng),
    startAt,
    endAt,
    dj: cleanString(source.dj, 80),
    price: cleanString(source.price, 50),
    organizer: cleanString(source.organizer, 100),
    submitterEmail: cleanEmail(source.submitterEmail || source.email),
    link: cleanUrl(source.link),
    description: cleanMultiline(source.description || source.desc, 1200),
    status: normalizeStatus(source.status),
    source: cleanString(source.source || 'legacy', 30),
    fingerprint: cleanString(source.fingerprint, 100),
    createdAt: toIso(source.createdAt) || startAt || new Date().toISOString(),
    updatedAt: toIso(source.updatedAt) || toIso(source.createdAt) || new Date().toISOString(),
    approvedAt: toIso(source.approvedAt),
    rejectedAt: toIso(source.rejectedAt),
    archivedAt: toIso(source.archivedAt),
    submittedFrom: cleanString(source.submittedFrom, 100),
  };
}

function isExpired(event, nowMs = Date.now()) {
  if (!event || !event.endAt) return false;
  const endMs = new Date(event.endAt).getTime();
  return Number.isFinite(endMs) && endMs < nowMs;
}

function publicEvent(event, going = 0) {
  return {
    id: event.id,
    title: event.title,
    style: event.style,
    city: event.city,
    location: event.location,
    address: event.address,
    lat: event.lat,
    lng: event.lng,
    startAt: event.startAt,
    endAt: event.endAt,
    date: event.startAt ? event.startAt.slice(0, 10) : '',
    dj: event.dj,
    price: event.price,
    organizer: event.organizer,
    link: event.link,
    description: event.description,
    desc: event.description,
    status: event.status,
    going: Math.max(0, Number.parseInt(going, 10) || 0),
  };
}

function validateEventInput(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const now = Date.now();

  const title = cleanString(source.title, 100);
  const style = cleanString(source.style, 30);
  const city = cleanString(source.city, 100);
  const location = cleanString(
    source.location || source.address || source.loc,
    180
  );
  const address = cleanString(source.address || location, 180);
  const lat = toNumber(source.lat);
  const lng = toNumber(source.lng);
  const startAt = toIso(source.startAt || source.date, false);
  const endAt = toIso(source.endAt || source.date, true);
  const linkRaw = cleanString(source.link, 500);
  const link = cleanUrl(linkRaw);
  const submitterEmailRaw = cleanString(
    source.submitterEmail || source.email,
    180
  );
  const submitterEmail = cleanEmail(submitterEmailRaw);

  if (title.length < 3) throw new Error('Le nom de l’événement est trop court');
  if (!ALLOWED_STYLES.includes(style)) throw new Error('Style invalide');
  if (location.length < 4) throw new Error('Adresse ou lieu obligatoire');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('Latitude invalide');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('Longitude invalide');
  }
  if (!startAt || !endAt) throw new Error('Date de début et date de fin obligatoires');

  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();

  if (endMs <= startMs) {
    throw new Error('La date de fin doit être après la date de début');
  }
  if (endMs < now && !options.allowExpired) {
    throw new Error('Cet événement est déjà terminé');
  }
  if (startMs > now + 1000 * 60 * 60 * 24 * 730) {
    throw new Error('La date est trop éloignée dans le futur');
  }
  if (endMs - startMs > 1000 * 60 * 60 * 24 * 31) {
    throw new Error('La durée de l’événement dépasse 31 jours');
  }
  if (linkRaw && !link) throw new Error('Lien invalide');
  if (submitterEmailRaw && !submitterEmail) throw new Error('Adresse e-mail invalide');

  return {
    title,
    style,
    city,
    location,
    address,
    lat,
    lng,
    startAt,
    endAt,
    dj: cleanString(source.dj, 80),
    price: cleanString(source.price, 50),
    organizer: cleanString(source.organizer, 100),
    submitterEmail,
    link,
    description: cleanMultiline(source.description || source.desc, 1200),
  };
}

function fingerprintFor(input) {
  const day = String(input.startAt || '').slice(0, 10);
  const basis = [
    cleanString(input.title, 100).toLowerCase(),
    cleanString(input.location || input.address, 180).toLowerCase(),
    day,
  ]
    .join('|')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

  return crypto.createHash('sha256').update(basis).digest('hex');
}

async function getEvent(id) {
  const raw = await redis(['HGET', EVENTS_KEY, String(id)]);
  if (!raw) return null;

  try {
    return normalizeStoredEvent(JSON.parse(raw), String(id));
  } catch {
    return null;
  }
}

async function saveEvent(event) {
  const normalized = normalizeStoredEvent(event, event.id);
  normalized.updatedAt = new Date().toISOString();

  await redis([
    'HSET',
    EVENTS_KEY,
    String(normalized.id),
    JSON.stringify(normalized),
  ]);

  return normalized;
}

async function deleteEvent(id, event = null) {
  const current = event || (await getEvent(id));
  const commands = [
    ['HDEL', EVENTS_KEY, String(id)],
    ['HDEL', GOING_KEY, String(id)],
  ];

  if (current && current.fingerprint) {
    commands.push(['HDEL', DEDUPE_KEY, current.fingerprint]);
  }

  await pipeline(commands);
}

async function loadAllEvents({ cleanup = true } = {}) {
  const [eventRaw, goingRaw] = await pipeline([
    ['HGETALL', EVENTS_KEY],
    ['HGETALL', GOING_KEY],
  ]);

  const eventMap = parseHash(eventRaw);
  const goingMap = parseHash(goingRaw);
  const events = [];

  for (const [id, value] of Object.entries(eventMap)) {
    try {
      const event = normalizeStoredEvent(JSON.parse(value), id);
      event.going = Math.max(0, Number.parseInt(goingMap[id], 10) || 0);
      events.push(event);
    } catch {
      // Une entrée corrompue ne bloque pas toute l’application.
    }
  }

  if (cleanup) await cleanupExpiredEvents(events);
  return events;
}

async function cleanupExpiredEvents(events = null) {
  const list = events || (await loadAllEvents({ cleanup: false }));
  const now = Date.now();
  const retentionMs = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const commands = [];
  let archived = 0;
  let deleted = 0;

  for (const event of list) {
    if (
      isExpired(event, now) &&
      !['archived', 'rejected'].includes(event.status)
    ) {
      event.status = 'archived';
      event.archivedAt = new Date().toISOString();
      event.updatedAt = event.archivedAt;
      commands.push([
        'HSET',
        EVENTS_KEY,
        String(event.id),
        JSON.stringify(event),
      ]);
      archived += 1;
      continue;
    }

    if (event.status === 'archived' && event.archivedAt) {
      const archivedMs = new Date(event.archivedAt).getTime();
      if (Number.isFinite(archivedMs) && now - archivedMs > retentionMs) {
        commands.push(['HDEL', EVENTS_KEY, String(event.id)]);
        commands.push(['HDEL', GOING_KEY, String(event.id)]);
        if (event.fingerprint) {
          commands.push(['HDEL', DEDUPE_KEY, event.fingerprint]);
        }
        event._deleted = true;
        deleted += 1;
      }
    }
  }

  if (commands.length) {
    for (let index = 0; index < commands.length; index += 80) {
      await pipeline(commands.slice(index, index + 80));
    }
  }

  return { archived, deleted };
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const first = new Date(a.startAt || 0).getTime();
    const second = new Date(b.startAt || 0).getTime();
    return first - second;
  });
}

module.exports = {
  EVENTS_KEY,
  GOING_KEY,
  DEDUPE_KEY,
  ALLOWED_STYLES,
  ALLOWED_STATUSES,
  cleanString,
  validateEventInput,
  normalizeStoredEvent,
  fingerprintFor,
  isExpired,
  publicEvent,
  getEvent,
  saveEvent,
  deleteEvent,
  loadAllEvents,
  cleanupExpiredEvents,
  sortEvents,
};
