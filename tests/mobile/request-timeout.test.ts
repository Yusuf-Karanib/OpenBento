import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('mobile API calls stop waiting when the server does not answer', () => {
  const api = readFileSync('mobile/src/lib/api.ts', 'utf8');

  assert.match(api, /const API_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(api, /const controller = new AbortController\(\)/);
  assert.match(api, /signal: controller\.signal/);
  assert.match(api, /finally\s*\{\s*clearTimeout\(timeout\)/);
});
