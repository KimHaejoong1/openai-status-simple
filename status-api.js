const API_BASE = 'https://status.openai.com/api/v2';
export const REFRESH_INTERVAL = 60_000;

function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

export function validateComponents(data) {
  if (!Array.isArray(data?.components) || !data.components.length ||
    data.components.some(item => !item || !nonempty(item.id) || !nonempty(item.name) || !nonempty(item.status)) ||
    new Set(data.components.map(item => item.id)).size !== data.components.length) {
    throw new Error('Invalid components response');
  }
  return data.components.filter(item => !item.group);
}

export function validateStatus(data) {
  if (!nonempty(data?.status?.indicator)) throw new Error('Invalid status response');
  return data.status.indicator;
}

export function validateIncidents(data) {
  if (!Array.isArray(data?.incidents) || data.incidents.some(item =>
    !item || !nonempty(item.id) || !nonempty(item.name) || !nonempty(item.status))) {
    throw new Error('Invalid incidents response');
  }
  return data.incidents;
}

async function request(path, validate, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API_BASE}/${path}.json`, {
      signal: controller.signal, cache: 'no-store', credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Status API returned HTTP ${response.status}`);
    return validate(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchStatus({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  // summary.json can truncate components and omit incidents. Fetch full feeds separately.
  const [status, components, incidents] = await Promise.allSettled([
    request('status', validateStatus, fetchImpl, timeoutMs),
    request('components', validateComponents, fetchImpl, timeoutMs),
    request('incidents', validateIncidents, fetchImpl, timeoutMs),
  ]);
  return {
    indicator: status.status === 'fulfilled' ? status.value : 'unknown',
    components: components.status === 'fulfilled' ? components.value : [],
    incidents: incidents.status === 'fulfilled' ? incidents.value : null,
    statusAvailable: status.status === 'fulfilled',
    componentsAvailable: components.status === 'fulfilled',
    checkedAt: new Date(),
  };
}
