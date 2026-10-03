// Component IDs are from the official component feed and page grouping (2026-10-04).
// Use IDs rather than positions or names: both API and ChatGPT contain "Login".
export const SERVICES = [
  { id: 'chatgpt', name: 'ChatGPT', description: '대화, 검색, 이미지 생성', icon: 'chat', components: [
    '01JMXBNJXGV1T5GT2M9XA83XNG', '01JMXBNJXG1S2D9V65P1ZZTD94',
    '01KX45G1SH21AX5DT93D4HMF0P', '01KMKFAMWKQ81YWSE1Z18R6VHR',
    '01JNKS9D9S72PMP1938PVFFQN4', '01JMXBNJXGKKP51D4DEJ2HZJ8Q',
    '01JMXBNJXG1YMQPPCPCQX3MPA2', '01JMXBNJXGGT5SR5DB9J7GYY48',
    '01JSFK5QX36ZRW0TW0ZV0ZYFXQ', '01JQ7EKW990MSPSWVXC7VPV2ZJ',
    '01JSYVYQSWMJ9QG35XHP08BHA7', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ',
    '01M3Q6NERHVE2WPPAQRHBAC6XB', '01M3Q6NERHS4BG0HQ85VAR1SRH',
    '01KX45G1SHQQ9DTAX9S4W7FV8G', '01K6TVGGGDCP0PPGCHXAG3AQX8',
  ] },
  { id: 'api', name: 'API', description: '모델, 음성, 개발자 도구', icon: 'api', components: [
    '01JMXBRMFE6N2NNT7DG6XZQ6PW', '01JP8CD9JR3HR6Y7G4Q75N4DVW',
    '01M3Q6W0264T1RJS1YEM47CAQJ', '01M3Q6W0262E8VW5DE1MJMMN0T',
    '01JMXBRMFEMZK0HPK19RYET250', '01JMXBRMFEV0AJ0VVS68N9CD6R',
    '01JMXBRMFE4MAP2BHSJNZ787WX', '01JMXBRMFE5ESNNV8JDHVCGSRD',
    '01JMXBRMFEKVBWKK82B44QFMCE', '01JMXBRMFEVZ7E0X9GD9FWR9WX',
    '01JMXBRMFEQW613TFE89F45035', '01JMXBRMFESJCBGJR10PDD3WCQ',
    '01JSM5RTJWHRWDTS6Q604VEW3B',
  ] },
  { id: 'codex', name: 'Codex', description: '코딩 에이전트, CLI, 에디터', icon: 'code', components: [
    '01JVCV8YSWZFRSM1G5CVP253SK', '01KMP3KP5MGE23B80K1EK4S8PV',
    '01KMKFAMWKNQ84Z1766MV08ZDE', '01KMP3KP5M8X0EBTVW6KN327EE',
  ] },
  { id: 'fedramp', name: 'FedRAMP', description: '미국 공공기관용 서비스', icon: 'shield', components: ['01KKAD7C71MCCH3FTREMJH4AAS'] },
  { id: 'ads', name: 'Ads Platform', description: '광고 관리, 광고 API', icon: 'grid', components: ['01KTQBYVARFJ5KMCSECM06VKCF', '01KVR95C58GGWHV7RYBT32NP11'] },
];

export const STATES = {
  operational: { label: '정상', tone: 'good', rank: 0 },
  unknown: { label: '확인 불가', tone: 'unknown', rank: 1 },
  under_maintenance: { label: '점검 중', tone: 'maintenance', rank: 2 },
  degraded_performance: { label: '성능 저하', tone: 'warning', rank: 3 },
  partial_outage: { label: '일부 장애', tone: 'warning', rank: 4 },
  major_outage: { label: '서비스 장애', tone: 'danger', rank: 5 },
};

export function normalizeState(value) {
  if (value === 'full_outage') return 'major_outage';
  return Object.hasOwn(STATES, value) ? value : 'unknown';
}

export function worstState(values) {
  if (!values.length) return 'unknown';
  return values.map(normalizeState).reduce((worst, state) =>
    STATES[state].rank > STATES[worst].rank ? state : worst, 'operational');
}

export function groupComponents(components) {
  const byId = new Map(components.map(component => [component.id, component]));
  const knownIds = new Set(SERVICES.flatMap(service => service.components));
  const groups = SERVICES.map(service => {
    const members = service.components.map(id => byId.get(id)).filter(Boolean);
    const missing = members.length < service.components.length;
    return { ...service, components: members, missing,
      status: worstState([...members.map(component => component.status), ...(missing ? ['unknown'] : [])]) };
  });
  // Never silently drop components added by the provider.
  const extra = components.filter(component => !knownIds.has(component.id));
  if (extra.length) groups.push({ id: 'other', name: '그 외 서비스', description: '새로 추가된 서비스', icon: 'grid', components: extra, missing: false, status: worstState(extra.map(component => component.status)) });
  return groups;
}

export function isActiveIncident(incident) {
  return !['resolved', 'postmortem', 'completed'].includes(incident.status);
}

const INDICATORS = { none: 'operational', minor: 'degraded_performance', major: 'partial_outage', critical: 'major_outage', maintenance: 'under_maintenance' };
const IMPACTS = { none: 'degraded_performance', minor: 'degraded_performance', major: 'partial_outage', critical: 'major_outage' };

export function overallState(indicator, groups, incidents = []) {
  return worstState([
    INDICATORS[indicator] ?? 'unknown',
    ...groups.map(group => group.status),
    ...incidents.filter(isActiveIncident).map(incident => IMPACTS[incident.impact] ?? 'degraded_performance'),
  ]);
}

export function selectIncidents(incidents) {
  const sorted = [...incidents].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  const active = sorted.filter(isActiveIncident);
  return active.length ? active : sorted.slice(0, 1);
}

export function incidentUrl(id) {
  return `https://status.openai.com/incidents/${encodeURIComponent(id)}`;
}
