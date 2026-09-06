import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('public YouTube search routes share a request limit', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const channelRoute = routes.slice(
    routes.indexOf('app.get("/api/youtube/channel-live/:channelId"'),
    routes.indexOf('app.get("/api/youtube/video-live/:videoId"'),
  );
  const handleRoute = routes.slice(
    routes.indexOf('app.get("/api/youtube/search-live/:channelHandle"'),
    routes.indexOf('app.post("/api/stream/heal"'),
  );
  const legacyLiveRoute = routes.slice(
    routes.indexOf('app.get("/api/live-video"'),
    routes.indexOf('// Kick API proxy'),
  );

  assert.match(channelRoute, /youtubeSearchRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(handleRoute, /youtubeSearchRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(legacyLiveRoute, /youtubeSearchRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(channelRoute, /channelId\.length > 200/);
  assert.match(handleRoute, /channelHandle\.length > 200/);
  assert.match(legacyLiveRoute, /channelId\.length > 200/);
});

test('public YouTube video lookups validate IDs and share a generous request limit', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  const videoLiveRoute = routes.slice(
    routes.indexOf('app.get("/api/youtube/video-live/:videoId"'),
    routes.indexOf('app.get("/api/youtube/search-live/:channelHandle"'),
  );
  const validateRoute = routes.slice(
    routes.indexOf('app.post("/api/stream/validate"'),
    routes.indexOf('// Personal-library data'),
  );

  assert.match(videoLiveRoute, /YOUTUBE_VIDEO_ID_PATTERN\.test\(videoId\)/);
  assert.match(validateRoute, /YOUTUBE_VIDEO_ID_PATTERN\.test\(videoId\)/);
  assert.match(videoLiveRoute, /youtubeVideoRateLimit\.allow\(getClientIp\(req\)\)/);
  assert.match(validateRoute, /youtubeVideoRateLimit\.allow\(getClientIp\(req\)\)/);
});
