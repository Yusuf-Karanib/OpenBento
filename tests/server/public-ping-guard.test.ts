import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the public network checker has an abuse limit', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const pingRoute = routes.slice(
    routes.indexOf("app.get('/api/ping'"),
    routes.indexOf('// Auto-import channels on startup'),
  );

  assert.match(pingRoute, /publicPingRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(pingRoute, /status\(429\)/);
});
