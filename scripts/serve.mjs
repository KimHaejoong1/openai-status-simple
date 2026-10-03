import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { scenarioData, scenarioNames } from './scenarios.mjs';

const root = new URL('../', import.meta.url);
const files = new Map([
  ['popup.html', 'text/html'], ['styles.css', 'text/css'],
  ['popup.js', 'text/javascript'], ['status.js', 'text/javascript'], ['status-api.js', 'text/javascript'],
  ['images/status.svg', 'image/svg+xml'],
]);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const match = url.pathname.match(/^\/scenarios\/([^/]+)\/(.+)$/);
  const scenario = match?.[1];
  const path = match?.[2] ?? (url.pathname === '/' ? 'popup.html' : url.pathname.slice(1));
  if (scenario && !scenarioNames.includes(scenario)) { res.writeHead(404).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (scenario && /^api\/(status|components|incidents)\.json$/.test(path)) {
    const endpoint = path.split('/')[1].replace('.json', '');
    res.setHeader('Content-Type', 'application/json');
    if (scenario === 'offline' || (scenario === 'notices-failed' && endpoint === 'incidents')) {
      res.writeHead(503).end('{"error":"Preview: unavailable"}');
    } else res.end(JSON.stringify(scenarioData(scenario)[endpoint]));
    return;
  }
  if (!files.has(path)) { res.writeHead(404).end('Not found'); return; }
  try {
    let content = await readFile(new URL(path, root), 'utf8');
    if (scenario && path === 'status-api.js') content = content.replace('https://status.openai.com/api/v2', `/scenarios/${scenario}/api`);
    if (scenario && path === 'popup.html') content = content.replace('<title>OpenAI Status</title>', `<title>Preview: ${scenario}</title>`).replace('<main class="app">', `<main class="app"><p class="data-notice">테스트 미리보기 · ${scenario} · 실제 상태가 아닙니다</p>`);
    res.setHeader('Content-Type', `${files.get(path)}; charset=utf-8`);
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self' https://status.openai.com; base-uri 'none'");
    res.end(content);
  } catch { res.writeHead(500).end('Could not read file'); }
}).listen(4173, '127.0.0.1', () => {
  console.log('Live preview: http://127.0.0.1:4173/popup.html');
  console.log('Scenario previews: http://127.0.0.1:4173/scenarios/{healthy,degraded,outage,maintenance,unknown,incomplete,offline,notices-failed}/popup.html');
});
