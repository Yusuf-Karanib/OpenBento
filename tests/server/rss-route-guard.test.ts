import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function rssRouteSource(): string {
  const routes = readFileSync('server/routes.ts', 'utf8');
  return routes.slice(
    routes.indexOf('// ─── RSS Headlines API'),
    routes.indexOf('// ─── Network / Uptime Light API'),
  );
}

test('cached RSS responses skip DNS and upstream work', () => {
  const route = rssRouteSource();
  const cacheRead = route.indexOf('const fresh = RSS_CACHE.get(cacheKey)');
  const dnsValidation = route.indexOf('await validateHostIsPublic(parsedUrl.hostname)');

  assert.ok(cacheRead >= 0);
  assert.ok(dnsValidation > cacheRead);
});

test('uncached RSS lookups are limited and keep SSRF protections', () => {
  const route = rssRouteSource();

  assert.match(route, /rssLookupRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(route, /status\(429\)/);
  assert.match(route, /targets\.some\(isPrivateOrReservedIp\)/);
  assert.match(route, /redirect: 'manual'/);
  assert.match(route, /MAX_BODY_BYTES/);
});
