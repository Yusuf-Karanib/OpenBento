import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('weather and news requests cannot wait forever', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const publicDataRoutes = routes.slice(
    routes.indexOf('// ─── Weather API'),
    routes.indexOf('// ─── Markets API'),
  );

  const timedFetches = publicDataRoutes.match(
    /fetch\(url, \{ signal: AbortSignal\.timeout\(8_000\) \}\)/g,
  );

  assert.equal(timedFetches?.length, 3);
});

test('weather and news routes share an abuse limit', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');

  const guardedRoutes = routes.match(
    /publicDataRateLimit\.allow\(getClientIp\(req\)\)/g,
  );

  assert.equal(guardedRoutes?.length, 5);
  assert.match(routes, /Too many public data requests/);
});

test('successful weather and news responses are cached', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const publicDataRoutes = routes.slice(
    routes.indexOf('// ─── Weather API'),
    routes.indexOf('// ─── Markets API'),
  );

  assert.equal(publicDataRoutes.match(/weatherCache\.get\(cacheKey\)/g)?.length, 2);
  assert.equal(publicDataRoutes.match(/weatherCache\.set\(cacheKey, mapped\)/g)?.length, 2);
  assert.match(publicDataRoutes, /newsCache\.get\(cacheKey\)/);
  assert.match(publicDataRoutes, /newsCache\.set\(cacheKey, mapped\)/);
});
