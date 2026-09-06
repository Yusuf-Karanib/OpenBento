import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = readFileSync('server/routes.ts', 'utf8');

test('database and admin errors stay in server logs instead of API responses', () => {
  assert.match(routes, /console\.error\(`\[API\] \$\{req\.method\} \$\{req\.path\} failed:`/);
  assert.match(routes, /error: "Internal server error"/);
  assert.doesNotMatch(routes, /error:\s*String\(error\)/);
});
