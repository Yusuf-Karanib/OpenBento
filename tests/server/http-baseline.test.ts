import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync('server/index.ts', 'utf8');

test('the server hides its framework and sends basic browser protections', () => {
  assert.match(server, /app\.disable\("x-powered-by"\)/);
  assert.match(server, /"X-Content-Type-Options", "nosniff"/);
  assert.match(server, /"Referrer-Policy", "strict-origin-when-cross-origin"/);
});

test('JSON uploads are not needlessly copied into rawBody memory', () => {
  assert.doesNotMatch(server, /rawBody|verify:\s*\(/);
  assert.match(server, /express\.json\(\{ limit: '10mb' \}\)/);
});

test('unexpected server errors do not expose their internal message', () => {
  assert.match(server, /status >= 500\s*\? "Internal Server Error"/);
});
