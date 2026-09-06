import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('YouTube page fetches cannot freeze a manual refresh', () => {
  const refresher = readFileSync('server/link-refresher.ts', 'utf8');
  const fetchSection = refresher.slice(
    refresher.indexOf('const response = await fetch(liveUrl'),
    refresher.indexOf('if (!response.ok)'),
  );

  assert.match(fetchSection, /signal: AbortSignal\.timeout\(10_000\)/);
});

test('manual link refreshes only update runtime memory', () => {
  const refresher = readFileSync('server/link-refresher.ts', 'utf8');

  assert.match(refresher, /let runtimeLinks: LinksData \| null = null/);
  assert.match(refresher, /runtimeLinks = data/);
  assert.doesNotMatch(refresher, /writeFileSync|mkdirSync/);
});

test('link refresh does not start automatically with the server', () => {
  const refresher = readFileSync('server/link-refresher.ts', 'utf8');
  const routes = readFileSync('server/routes.ts', 'utf8');

  assert.doesNotMatch(refresher, /startLinkRefresher|setInterval/);
  assert.doesNotMatch(routes, /startLinkRefresher/);
  assert.match(routes, /app\.post\("\/api\/admin\/links\/refresh"/);
  assert.match(routes, /const data = await refreshAllLinks\(\)/);
});
