import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guard = readFileSync('client/src/components/mobile-guard.tsx', 'utf8');

test('the mobile warning does not collect an email it cannot send', () => {
  assert.doesNotMatch(guard, /openBentoMobileNotify|Notify Me When Ready|We'll notify/);
  assert.match(guard, /Continue Anyway/);
});

test('small screens can still reach legal, recovery, feedback, and Cast routes', () => {
  assert.match(guard, /const isDesktopWorkspace = location === '\/' \|\| location === '\/admin'/);
  assert.match(guard, /!isDesktopWorkspace/);
});
