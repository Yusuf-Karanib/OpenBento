import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateFeedbackScreenshot } from '../../server/services/feedback-screenshot';

function dataUrl(type: 'png' | 'jpeg' | 'svg+xml', bytes: Buffer): string {
  return `data:image/${type};base64,${bytes.toString('base64')}`;
}

test('feedback accepts PNG and JPEG screenshots with matching file signatures', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

  assert.deepEqual(validateFeedbackScreenshot(dataUrl('png', png)), { ok: true });
  assert.deepEqual(validateFeedbackScreenshot(dataUrl('jpeg', jpeg)), { ok: true });
});

test('feedback rejects script-capable SVG and files with a fake image label', () => {
  const svg = Buffer.from('<svg onload="alert(1)"></svg>');

  assert.equal(validateFeedbackScreenshot(dataUrl('svg+xml', svg)).ok, false);
  assert.equal(validateFeedbackScreenshot(dataUrl('png', svg)).ok, false);
  assert.equal(validateFeedbackScreenshot('data:image/png;base64,not base64').ok, false);
});

test('feedback rejects decoded screenshots over five megabytes', () => {
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = validateFeedbackScreenshot(dataUrl('png', oversized));

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /under 5MB/);
});

test('opening an untrusted screenshot cannot control the admin window', () => {
  const admin = readFileSync('client/src/pages/admin.tsx', 'utf8');
  assert.match(admin, /window\.open\(item\.screenshot!, '_blank', 'noopener,noreferrer'\)/);
});
