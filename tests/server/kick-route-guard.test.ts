import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the public Kick checker validates input, limits abuse, and times out', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const kickRoute = routes.slice(
    routes.indexOf('app.get("/api/kick/channel/:channelId"'),
    routes.indexOf('app.post("/api/stream/validate"'),
  );

  assert.match(kickRoute, /KICK_CHANNEL_PATTERN\.test\(channelId\)/);
  assert.match(kickRoute, /kickStatusRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(kickRoute, /status\(429\)/);
  assert.match(kickRoute, /AbortSignal\.timeout\(5_000\)/);
  assert.match(kickRoute, /kickStatusCache\.get\(channelId\)/);
  assert.match(kickRoute, /kickStatusCache\.dedupe\(channelId/);
  assert.match(kickRoute, /kickStatusCache\.set\(channelId, unknown\)/);
});
