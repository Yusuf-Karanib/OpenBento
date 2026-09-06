import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('uncached ISS pass predictions are rate limited', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const passRoute = routes.slice(
    routes.indexOf("app.get('/api/iss/pass'"),
    routes.indexOf('// ─── Knowledge & Play pack'),
  );

  const cacheRead = passRoute.indexOf('ISS_PASS_CACHE.get(cacheKey)');
  const limitCheck = passRoute.indexOf('issPassRateLimit.allow(getClientIp(req))');

  assert.ok(cacheRead >= 0);
  assert.ok(limitCheck > cacheRead);
  assert.match(passRoute, /status\(429\)/);
  assert.match(passRoute, /AbortController/);
});
