import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/components.json', import.meta.url), 'utf8'));
export const scenarioNames = ['healthy', 'degraded', 'outage', 'maintenance', 'unknown', 'incomplete', 'offline', 'notices-failed'];

export function scenarioData(name) {
  const components = structuredClone(fixture);
  const status = { status: { indicator: 'none' } };
  const incidents = { incidents: [{ id: 'preview-resolved', name: 'Example: ChatGPT service has recovered', status: 'resolved', updated_at: '2026-10-03T12:00:00Z' }] };
  if (name === 'degraded' || name === 'outage') {
    components.components.find(item => item.name === 'Conversations').status = name === 'outage' ? 'major_outage' : 'degraded_performance';
    status.status.indicator = name === 'outage' ? 'critical' : 'minor';
    incidents.incidents.unshift({ id: 'preview-active', name: 'Example: Elevated errors in ChatGPT', status: 'monitoring', impact: name === 'outage' ? 'critical' : 'minor', updated_at: '2026-10-03T13:00:00Z', incident_updates: [{ created_at: '2026-10-03T13:00:00Z', body: 'We have applied a mitigation and are monitoring the recovery.' }] });
  }
  if (name === 'maintenance') components.components.find(item => item.name === 'Ads API').status = 'under_maintenance';
  if (name === 'unknown') components.components.find(item => item.name === 'Responses').status = 'unrecognized_status';
  if (name === 'incomplete') components.components = components.components.slice(0, 25);
  return { status, components, incidents };
}
