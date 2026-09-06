import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('GitHub widget requests validate names, cache results, and time out', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const githubRoutes = routes.slice(
    routes.indexOf('// ─── GitHub Pulse API'),
    routes.indexOf('// ─── RSS / Atom Feed API'),
  );

  assert.match(githubRoutes, /GITHUB_NAME_RE\.test\(owner\)/);
  assert.match(githubRoutes, /GITHUB_CACHE\.dedupe\(cacheKey/);
  assert.match(githubRoutes, /GITHUB_USER_CACHE\.dedupe\(cacheKey/);
  assert.equal(githubRoutes.match(/AbortSignal\.timeout\(8_000\)/g)?.length, 6);
});

test('uncached GitHub widget lookups share an abuse limit', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const githubRoutes = routes.slice(
    routes.indexOf('// ─── GitHub Pulse API'),
    routes.indexOf('// ─── RSS / Atom Feed API'),
  );

  assert.equal(
    githubRoutes.match(/githubLookupRateLimit\.allow\(getClientIp\(req\)\)/g)?.length,
    2,
  );
  assert.equal(
    githubRoutes.match(/Too many GitHub lookups\. Please try again later\./g)?.length,
    2,
  );
});
