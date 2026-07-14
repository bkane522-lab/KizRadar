const URL_BASE = (
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  ''
).replace(/\/$/, '');

const TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';

const REDIS_TIMEOUT_MS = 8000;

function redisConfigured() {
  return Boolean(URL_BASE && TOKEN);
}

async function redisRaw(payload, endpoint = '') {
  if (!redisConfigured()) {
    throw new Error('Base de données non configurée');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${URL_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Base de données injoignable : délai dépassé');
    }
    throw new Error('Erreur réseau lors de la connexion à la base');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Réponse invalide de la base de données');
  }

  if (!response.ok) {
    throw new Error(
      (json && (json.error || json.message)) ||
      `Erreur Redis ${response.status}`
    );
  }

  return json;
}

async function redis(command) {
  const json = await redisRaw(command);
  if (json && json.error) throw new Error(json.error);
  return json ? json.result : null;
}

async function pipeline(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const json = await redisRaw(commands, '/pipeline');

  if (json && json.error) throw new Error(json.error);
  if (!Array.isArray(json)) throw new Error('Réponse pipeline invalide');

  return json.map((item) => {
    if (item && item.error) throw new Error(item.error);
    return item ? item.result : null;
  });
}

function parseHash(raw) {
  if (!raw) return {};

  if (!Array.isArray(raw) && typeof raw === 'object') {
    return raw;
  }

  const result = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i] !== undefined) result[String(raw[i])] = raw[i + 1];
    }
  }
  return result;
}

module.exports = {
  redisConfigured,
  redis,
  pipeline,
  parseHash,
};
