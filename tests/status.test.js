import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { groupComponents, overallState, worstState, selectIncidents, incidentUrl } from '../status.js';
import { fetchStatus, validateComponents, validateStatus, validateIncidents } from '../status-api.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/components.json', import.meta.url), 'utf8'));
const freshComponents = () => structuredClone(fixture.components);

test('official full feed maps all 36 components into the correct five services', () => {
  const groups = groupComponents(freshComponents());
  assert.deepEqual(groups.map(group => [group.name, group.components.length]), [['ChatGPT', 16], ['API', 13], ['Codex', 4], ['FedRAMP', 1], ['Ads Platform', 2]]);
  assert.equal(overallState('none', groups), 'operational');
});

test('duplicate Login names stay in their own service even if the feed is reordered', () => {
  const components = freshComponents().reverse();
  components.find(component => component.id === '01JSM5RTJWHRWDTS6Q604VEW3B').status = 'partial_outage';
  const groups = groupComponents(components);
  assert.equal(groups.find(group => group.id === 'api').status, 'partial_outage');
  assert.equal(groups.find(group => group.id === 'chatgpt').status, 'operational');
});

test('a truncated summary cannot make missing Codex or other services look healthy', () => {
  const groups = groupComponents(freshComponents().slice(0, 25));
  assert.equal(groups.find(group => group.id === 'codex').status, 'unknown');
  assert.equal(groups.find(group => group.id === 'chatgpt').status, 'unknown');
  assert.equal(overallState('none', groups), 'unknown');
});

test('new components are visible and contribute to the overall state', () => {
  const groups = groupComponents([...freshComponents(), { id: 'new', name: 'New service', status: 'major_outage' }]);
  assert.equal(groups.at(-1).name, '그 외 서비스');
  assert.equal(overallState('none', groups), 'major_outage');
});

test('unknown status values never become operational', () => {
  assert.equal(worstState(['operational', 'new-status']), 'unknown');
  assert.equal(worstState([]), 'unknown');
  assert.equal(worstState(['toString']), 'unknown');
  assert.equal(overallState('new-indicator', groupComponents(freshComponents())), 'unknown');
});

test('severity preserves known outages even when another source is missing', () => {
  assert.equal(worstState(['unknown', 'under_maintenance', 'degraded_performance', 'partial_outage', 'full_outage']), 'major_outage');
  assert.equal(overallState('critical', groupComponents([])), 'major_outage');
});

test('summary degradation and active monitoring prevent an all-green overview', () => {
  const groups = groupComponents(freshComponents());
  assert.equal(overallState('minor', groups), 'degraded_performance');
  assert.equal(overallState('none', groups, [{ status: 'monitoring', impact: 'none' }]), 'degraded_performance');
  assert.equal(overallState('none', groups, [{ status: 'resolved', impact: 'critical' }]), 'operational');
});

test('older unresolved incidents take precedence over newer resolved notices without a date cutoff', () => {
  const incidents = [
    { id: 'old-active', status: 'identified', updated_at: '2024-01-01' },
    { id: 'resolved', status: 'resolved', updated_at: '2026-10-03' },
    { id: 'monitoring', status: 'monitoring', updated_at: '2026-10-02' },
  ];
  assert.deepEqual(selectIncidents(incidents).map(item => item.id), ['monitoring', 'old-active']);
  assert.equal(selectIncidents(incidents.slice(1, 2)).length, 1);
});

test('malformed, empty, and duplicate payloads are rejected', () => {
  for (const data of [{}, { components: [] }, { components: [null] }, { components: [{ id: '1', name: 'ChatGPT' }] }, { components: [fixture.components[0], fixture.components[0]] }]) assert.throws(() => validateComponents(data));
  assert.throws(() => validateStatus({}));
  assert.throws(() => validateIncidents({}));
  assert.throws(() => validateIncidents({ incidents: [null] }));
  assert.deepEqual(validateIncidents({ incidents: [] }), []);
});

test('incident URLs stay on the official origin even for hostile IDs', () => {
  const url = new URL(incidentUrl('https://evil.test/<script>'));
  assert.equal(url.origin, 'https://status.openai.com');
  assert.ok(!url.href.includes('<script>'));
});

function fakeFetch(failPath) {
  return async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    const path = new URL(url).pathname;
    if (path.endsWith(`${failPath}.json`)) throw new Error('Offline');
    return { ok: true, json: async () => path.endsWith('/status.json') ? { status: { indicator: 'none' } } : path.endsWith('/components.json') ? fixture : { incidents: [] } };
  };
}

test('full feed is loaded without relying on the truncated summary endpoint', async () => {
  const data = await fetchStatus({ fetchImpl: fakeFetch() });
  assert.equal(data.components.length, 36);
  assert.equal(data.statusAvailable, true);
  assert.equal(data.componentsAvailable, true);
  assert.deepEqual(data.incidents, []);
});

test('notice failure preserves separately verified service status', async () => {
  const data = await fetchStatus({ fetchImpl: fakeFetch('incidents') });
  assert.equal(data.incidents, null);
  assert.equal(overallState(data.indicator, groupComponents(data.components)), 'operational');
});

test('component failure is unknown even if the overall API says normal', async () => {
  const data = await fetchStatus({ fetchImpl: fakeFetch('components') });
  assert.equal(data.componentsAvailable, false);
  assert.equal(overallState(data.indicator, groupComponents(data.components)), 'unknown');
});

test('a failed refresh does not reuse a previous healthy response', async () => {
  await fetchStatus({ fetchImpl: fakeFetch() });
  const data = await fetchStatus({ fetchImpl: async () => { throw new Error('Offline'); } });
  assert.equal(data.statusAvailable, false);
  assert.equal(data.componentsAvailable, false);
  assert.equal(data.incidents, null);
  assert.equal(overallState(data.indicator, groupComponents(data.components)), 'unknown');
});

test('HTTP and invalid JSON failures are not treated as empty healthy responses', async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })]) {
    const data = await fetchStatus({ fetchImpl });
    assert.equal(data.componentsAvailable, false);
    assert.equal(data.indicator, 'unknown');
  }
});

test('requests abort after the timeout so the refresh control can recover', async () => {
  let aborted = 0;
  const data = await fetchStatus({ timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('Timeout')); })) });
  assert.equal(aborted, 3);
  assert.equal(data.componentsAvailable, false);
});
