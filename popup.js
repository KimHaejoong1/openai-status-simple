import { fetchStatus, REFRESH_INTERVAL } from './status-api.js';
import { STATES, groupComponents, normalizeState, overallState, worstState, selectIncidents, isActiveIncident, incidentUrl } from './status.js';

const $ = id => document.getElementById(id);
const refreshButton = $('refresh');
let loading = false;
let lastSuccess = null;
let refreshTimer;

const OVERVIEWS = {
  operational: ['모두 정상', '모든 서비스가 정상이에요', 'OpenAI가 보고한 현재 서비스 상태입니다.'],
  degraded_performance: ['성능 저하', '일부 서비스가 느릴 수 있어요', '영향받는 서비스와 최신 공지를 확인해 주세요.'],
  partial_outage: ['일부 장애', '일부 서비스에 문제가 있어요', '영향받는 서비스와 최신 공지를 확인해 주세요.'],
  major_outage: ['서비스 장애', '서비스 이용이 원활하지 않아요', 'OpenAI에서 보고한 장애가 진행 중입니다.'],
  under_maintenance: ['점검 중', '일부 서비스를 점검하고 있어요', '점검 중인 서비스는 이용이 제한될 수 있어요.'],
  unknown: ['확인 불가', '현재 상태를 확인할 수 없어요', '잠시 후 새로고침하거나 공식 페이지를 확인해 주세요.'],
};

const ICON_PATHS = {
  chat: ['M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z', 'M7 10h7M7 14h4'],
  api: ['M8 5 2 12l6 7M16 5l6 7-6 7M14 3l-4 18'],
  code: ['m5 6 6 6-6 6M13 18h6'],
  shield: ['m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z', 'm8 12 3 3 5-6'],
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const wrapper = element('span', 'service-icon');
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  wrapper.append(svg);
  return wrapper;
}

function statusLabel(state) {
  const { label, tone } = STATES[normalizeState(state)];
  const node = element('span', 'status-label');
  node.dataset.tone = tone;
  const dot = element('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  node.append(dot, document.createTextNode(label));
  return node;
}

function chevron() {
  const node = element('span', 'chevron');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function serviceRow(group, openIds) {
  const details = element('details', 'service');
  details.dataset.service = group.id;
  details.open = openIds.has(group.id);
  const summary = element('summary');
  const copy = element('span', 'service-copy');
  copy.append(element('span', 'service-name', group.name), element('span', 'service-description', group.description));
  summary.append(icon(group.icon), copy, statusLabel(group.status), chevron());
  const list = element('ul', 'components');
  const ordered = [...group.components].sort((a, b) => STATES[normalizeState(b.status)].rank - STATES[normalizeState(a.status)].rank);
  for (const component of ordered) {
    const li = element('li');
    li.append(element('span', null, component.name), statusLabel(component.status));
    list.append(li);
  }
  if (group.missing) list.append(element('li', 'muted', '일부 세부 상태를 확인할 수 없어요.'));
  details.append(summary, list);
  return details;
}

function renderServices(groups) {
  const container = $('services');
  const focusedService = document.activeElement?.closest('[data-service]')?.dataset.service;
  const openIds = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.service));
  const nodes = groups.slice(0, 3).map(group => serviceRow(group, openIds));
  const extras = groups.slice(3);
  const other = element('details', 'other-services');
  other.dataset.service = 'extras';
  // Keep issues visible even when they affect a less commonly used service.
  other.open = openIds.has('extras') || extras.some(group => group.status !== 'operational');
  const summary = element('summary');
  summary.append(element('span', null, `기타 서비스 ${extras.length}`), statusLabel(worstState(extras.map(group => group.status))), chevron());
  other.append(summary, ...extras.map(group => serviceRow(group, openIds)));
  container.replaceChildren(...nodes, other);
  if (focusedService) [...container.querySelectorAll('details')].find(node => node.dataset.service === focusedService)?.querySelector('summary')?.focus({ preventScroll: true });
  container.setAttribute('aria-busy', 'false');
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function renderIncidents(incidents) {
  const container = $('incidents');
  $('incidents-heading').textContent = incidents?.some(isActiveIncident) ? '진행 중인 이슈' : '최근 업데이트';
  if (incidents === null) {
    container.replaceChildren(element('p', 'muted', '공지 정보를 불러오지 못했어요. 전체 기록에서 확인해 주세요.'));
    return;
  }
  if (!incidents.length) {
    container.replaceChildren(element('p', 'muted', '최근 공지가 없어요.'));
    return;
  }
  const labels = { investigating: '조사 중', identified: '원인 확인', monitoring: '복구 확인 중', resolved: '해결됨', postmortem: '사후 분석', completed: '완료' };
  container.replaceChildren(...selectIncidents(incidents).map(incident => {
    const article = element('article', 'incident');
    const active = isActiveIncident(incident);
    const meta = element('div', 'incident-meta');
    const badge = element('span', 'incident-badge', labels[incident.status] ?? '진행 중');
    badge.dataset.tone = active ? 'warning' : 'good';
    meta.append(badge, element('span', null, dateLabel(incident.updated_at)));
    const link = element('a', null, `${incident.name} ↗`);
    link.href = incidentUrl(incident.id);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.lang = 'en';
    article.append(meta, link);
    if (active && Array.isArray(incident.incident_updates)) {
      const latest = [...incident.incident_updates].filter(update => update && typeof update.body === 'string').sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];
      if (latest?.body) {
        const body = element('p', 'incident-body', latest.body);
        body.lang = 'en';
        article.append(body);
      }
    }
    return article;
  }));
}

function render(data) {
  const groups = groupComponents(data.components);
  const state = overallState(data.indicator, groups, data.incidents ?? []);
  const [label, title, description] = OVERVIEWS[state];
  $('overview').dataset.tone = STATES[state].tone;
  $('overview-label').textContent = label;
  $('overview-title').textContent = title;
  $('overview-description').textContent = description;
  const healthy = groups.filter(group => group.status === 'operational').length;
  $('service-count').textContent = data.componentsAvailable ? `${groups.length}개 서비스 중 ${healthy}개 정상` : '상태 데이터 연결을 확인해 주세요';
  $('overview').setAttribute('aria-busy', 'false');
  renderServices(groups);
  renderIncidents(data.incidents);
  const notices = [];
  if (!data.statusAvailable || !data.componentsAvailable) notices.push('일부 상태 데이터를 불러오지 못했어요.');
  else if (groups.some(group => group.missing)) notices.push('공식 데이터에 일부 항목이 없어 해당 서비스는 확인 불가로 표시해요.');
  $('data-notice').hidden = !notices.length;
  $('data-notice').textContent = notices.join(' ');
  if (data.statusAvailable && data.componentsAvailable) {
    lastSuccess = data.checkedAt;
    $('sync-state').textContent = `${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(lastSuccess)} 확인`;
  } else {
    $('sync-state').textContent = lastSuccess ? `갱신 실패 · 마지막 성공 ${dateLabel(lastSuccess)}` : '연결을 확인해 주세요';
  }
}

async function refresh() {
  if (loading) return;
  clearTimeout(refreshTimer);
  loading = true;
  refreshButton.disabled = true;
  $('sync-state').textContent = '최신 상태 확인 중';
  try {
    render(await fetchStatus());
  } catch {
    render({ indicator: 'unknown', components: [], incidents: null, statusAvailable: false, componentsAvailable: false });
  } finally {
    loading = false;
    refreshButton.disabled = false;
    if (!document.hidden) refreshTimer = setTimeout(refresh, REFRESH_INTERVAL);
  }
}

refreshButton.addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer);
  if (!document.hidden) refresh();
});
window.addEventListener('online', refresh);
refresh();
