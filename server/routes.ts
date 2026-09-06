import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { isIP } from "net";
import { storage } from "./storage";
import { loadLinks, refreshAllLinks, getChannelUrl } from "./link-refresher";
import { initializePulseCache, getGlobalStreamStatus, getStreamStatus, registerChannel } from "./services/pulse-cache";
import { setupCastHub } from "./services/cast-hub";
import { healStream, getVideoDetails, isMusicCategory, checkChannelLiveStatus, verifyVideoIsLive, searchChannelLiveStream, checkVideoLiveStatusById } from "./services/youtube-api";
import { insertUserLibrarySchema, updateUserLibrarySchema, insertDashboardSchema, updateDashboardSchema, insertChannelSchema, insertFeedbackSchema } from "@shared/schema";
import { pickDailyWordleAnswer, wordleUtcDateKey } from "@shared/wordle-pool";
import { getResendClient } from "./services/resend-client";
import { createMarketsService, parseSymbols as parseMarketsSymbols } from "./markets";
import { createAirQualityService, geocodeCity as geocodeAirQualityCity } from "./air-quality";
import { LruTtlCache } from "./services/lruCache";
import { attachSupabaseUser as attachSupabaseUserShared } from "./services/supabaseAuth";
import { FixedWindowRateLimiter } from "./services/fixed-window-rate-limit";
import { streamHealRequestSchema } from "./services/stream-heal-guard";
import { parseWeatherLookup, weatherLookupCacheKey } from "./services/weather-query";
import { isAdminEmail } from "@shared/admin-access";
import { getClientIp } from "./services/client-ip";
import { validateFeedbackScreenshot } from "./services/feedback-screenshot";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Bearer-token middleware.
//
// The /api/dashboard cloud-sync routes need to identify the caller from a
// Supabase access token sent as `Authorization: Bearer …`. We verify the token
// by hitting Supabase's
// `/auth/v1/user` endpoint (cheap and reliable) and cache the result for 5
// minutes so we don't make a network call on every save.
// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware extracted to ./services/supabaseAuth.ts so the cast hub
// (and any other route module) can share the same LRU cache and verification
// logic. Re-exported under the local name so existing references compile.
const attachSupabaseUser = attachSupabaseUserShared;

const streamHealRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 12,
});
const youtubeSearchRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 12,
});
const youtubeVideoRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 120,
});
const publicPingRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 300,
});
const kickStatusRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 60,
});
const publicDataRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 120,
});
const githubLookupRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 60,
});
const rssLookupRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 60,
});
const issPassRateLimit = new FixedWindowRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 30,
});

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const KICK_CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

interface KickStatusPayload {
  isLive: boolean | null;
  viewerCount: number;
  channelId: string;
  status: 'ok' | 'unknown';
}

const kickStatusCache = new LruTtlCache<KickStatusPayload>({
  max: 500,
  ttlMs: 60 * 1000,
});
const weatherCache = new LruTtlCache<Record<string, unknown>>({
  max: 500,
  ttlMs: 5 * 60 * 1000,
});
const newsCache = new LruTtlCache<Record<string, unknown>>({
  max: 100,
  ttlMs: 10 * 60 * 1000,
});

function unknownKickStatus(channelId: string): KickStatusPayload {
  return { isLive: null, viewerCount: 0, channelId, status: 'unknown' };
}

function sendInternalError(
  req: Request,
  res: Response,
  error: unknown,
  extra: Record<string, unknown> = {},
): Response {
  console.error(`[API] ${req.method} ${req.path} failed:`, error);
  return res.status(500).json({ ...extra, error: "Internal server error" });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  initializePulseCache();

  app.get("/api/links", async (req, res) => {
    const origin = req.headers.origin || req.headers.referer || `${req.protocol}://${req.get('host')}`;
    const linksData = loadLinks();

    const jsonChannels = linksData.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      url: getChannelUrl(channel, origin),
      iconType: channel.iconType,
      category: channel.category,
      platform: channel.platform,
      channelId: channel.platform === 'youtube' ? channel.channelHandle : channel.channelHandle,
      videoId: channel.videoId,
      lastUpdated: channel.lastUpdated,
      isManualOverride: false,
      rank: 999,
    }));

    try {
      const allDbChannels = await storage.getAllChannels();
      const dbChannels = allDbChannels.filter(ch => ch.isVisible !== false);

      if (dbChannels.length > 0) {
        const dbOnly = dbChannels.map(dbCh => {
          let url = '';
          if (dbCh.platform === 'youtube' && dbCh.videoId) {
            url = `https://www.youtube.com/watch?v=${dbCh.videoId}`;
          } else if (dbCh.platform === 'youtube' && dbCh.channelHandle) {
            url = `https://www.youtube.com/@${dbCh.channelHandle}/live`;
          } else if (dbCh.platform === 'twitch') {
            url = `https://www.twitch.tv/${dbCh.channelHandle}`;
          } else if (dbCh.platform === 'kick') {
            url = `https://kick.com/${dbCh.channelHandle}`;
          }
          return {
            id: dbCh.id,
            name: dbCh.name,
            url,
            iconType: (dbCh.iconType as any) || 'default',
            category: dbCh.category || 'General',
            platform: dbCh.platform as any,
            channelId: dbCh.channelHandle || '',
            videoId: dbCh.videoId || null,
            lastUpdated: dbCh.lastUpdated ? new Date(dbCh.lastUpdated).getTime() : Date.now(),
            isManualOverride: dbCh.isManualOverride || false,
            rank: dbCh.rank ?? 999,
            isLive: dbCh.isLive ?? true,
            logoUrl: dbCh.logoUrl || null,
          };
        });

        res.json({
          channels: dbOnly,
          lastRefresh: linksData.lastRefresh,
          origin,
        });
        return;
      }

      res.json({
        channels: jsonChannels,
        lastRefresh: linksData.lastRefresh,
        origin,
      });
    } catch (error) {
      res.json({
        channels: jsonChannels,
        lastRefresh: linksData.lastRefresh,
        origin,
      });
    }
  });

  app.get("/api/stream-status", (req, res) => {
    const globalStatus = getGlobalStreamStatus();
    res.json({
      status: globalStatus,
      count: Object.keys(globalStatus).length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/stream-status/:channelId", (req, res) => {
    const { channelId } = req.params;
    const status = getStreamStatus(channelId);

    if (!status) {
      return res.status(404).json({ error: "Channel not found in cache" });
    }

    res.json(status);
  });

  // True Live Filter: Check if a YouTube channel is currently live
  app.get("/api/youtube/channel-live/:channelId", async (req, res) => {
    const { channelId } = req.params;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!youtubeSearchRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ isLive: null, apiError: true, error: "Too many YouTube searches, slow down" });
    }
    if (!channelId || channelId.length > 200) {
      return res.status(400).json({ isLive: null, apiError: true, error: "Invalid channel ID" });
    }

    if (!apiKey) {
      return res.status(503).json({
        isLive: null,
        error: "YouTube API key not configured"
      });
    }

    try {
      const result = await checkChannelLiveStatus(channelId, apiKey);
      res.json({
        channelId,
        isLive: result.isLive,
        liveVideoId: result.liveVideoId,
        title: result.title,
        apiError: result.apiError || false,
      });
    } catch (error) {
      sendInternalError(req, res, error, {
        channelId,
        isLive: null,
        apiError: true,
      });
    }
  });

  // QUOTA OPTIMIZATION: Uses videos.list (1 unit) instead of search.list (100 units)
  // This is the preferred endpoint for checking live status when videoId is known
  app.get("/api/youtube/video-live/:videoId", async (req, res) => {
    const { videoId } = req.params;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
      return res.status(400).json({ isLive: null, apiError: true, error: "Invalid video ID" });
    }
    if (!youtubeVideoRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ isLive: null, apiError: true, error: "Too many YouTube checks, slow down" });
    }

    if (!apiKey) {
      return res.status(503).json({
        isLive: null,
        error: "YouTube API key not configured"
      });
    }

    try {
      // Use checkVideoLiveStatusById which uses videos.list (1 unit)
      const result = await checkVideoLiveStatusById(videoId, apiKey);
      res.json({
        videoId,
        isLive: result.isLive,
        liveVideoId: result.liveVideoId,
        liveBroadcastContent: result.liveBroadcastContent,
        title: result.title,
        apiError: result.apiError || false,
      });
    } catch (error) {
      sendInternalError(req, res, error, {
        videoId,
        isLive: null,
        apiError: true,
      });
    }
  });

  // Search for current live stream by channel handle - returns new live video ID
  app.get("/api/youtube/search-live/:channelHandle", async (req, res) => {
    const { channelHandle } = req.params;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!youtubeSearchRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ isLive: false, apiError: true, error: "Too many YouTube searches, slow down" });
    }
    if (!channelHandle || channelHandle.length > 200) {
      return res.status(400).json({ isLive: false, apiError: true, error: "Invalid channel handle" });
    }

    if (!apiKey) {
      return res.status(503).json({
        isLive: false,
        error: "YouTube API key not configured"
      });
    }

    try {
      const result = await searchChannelLiveStream(channelHandle, apiKey);
      res.json({
        channelHandle,
        channelId: result.channelId,
        isLive: result.isLive,
        liveVideoId: result.liveVideoId,
        latestVideoId: result.latestVideoId, // LATEST-VIDEO FALLBACK: Returns latest video when not live
        title: result.title,
        apiError: result.apiError || false,
      });
    } catch (error) {
      sendInternalError(req, res, error, {
        channelHandle,
        isLive: false,
        latestVideoId: null,
        apiError: true,
      });
    }
  });

  app.post("/api/stream/heal", async (req, res) => {
    if (!streamHealRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ success: false, error: "Too many repair requests, slow down" });
    }

    const validation = streamHealRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: "Invalid repair request" });
    }
    const { channelId, channelName, currentVideoId } = validation.data;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: "YouTube API key not configured"
      });
    }

    try {
      const result = await healStream(channelName, channelId, apiKey);

      await storage.logHealing(
        channelId,
        currentVideoId || null,
        result.newVideoId || null,
        `${channelName} Live`,
        result.success,
        result.reason
      );

      if (result.success && result.newVideoId) {
        await registerChannel(channelId, channelName, 'youtube', result.newVideoId);
      }

      res.json(result);
    } catch (error) {
      sendInternalError(req, res, error, { success: false });
    }
  });

  app.get("/api/live-video", async (req, res) => {
    const { channelId } = req.query;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!youtubeSearchRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: "Too many YouTube searches, slow down", videoId: null });
    }

    if (!channelId || typeof channelId !== 'string' || channelId.length > 200) {
      return res.status(400).json({ error: "Invalid channelId parameter", videoId: null });
    }

    if (!apiKey) {
      return res.status(503).json({
        error: "YouTube API key not configured",
        videoId: null
      });
    }

    try {
      const result = await healStream(channelId, channelId, apiKey);

      if (result.success && result.newVideoId) {
        res.json({
          videoId: result.newVideoId,
          channelId,
          isLive: true
        });
      } else {
        res.json({
          videoId: null,
          channelId,
          reason: result.reason || "No live stream found"
        });
      }
    } catch (error) {
      sendInternalError(req, res, error, { videoId: null });
    }
  });

  // Kick API proxy (browser CORS blocked)
  app.get("/api/kick/channel/:channelId", async (req, res) => {
    const channelId = req.params.channelId?.trim().toLowerCase();

    if (!channelId || !KICK_CHANNEL_PATTERN.test(channelId)) {
      return res.status(400).json({ isLive: null, error: "Invalid Kick channel" });
    }
    if (!kickStatusRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ isLive: null, error: "Too many Kick status checks, slow down" });
    }

    const cached = kickStatusCache.get(channelId);
    if (cached) return res.json(cached);

    try {
      const result = await kickStatusCache.dedupe(channelId, async () => {
        // Try v2 API with full browser headers
        const response = await fetch(`https://kick.com/api/v2/channels/${channelId}`, {
          signal: AbortSignal.timeout(5_000),
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': `https://kick.com/${channelId}`,
            'Origin': 'https://kick.com',
            'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          }
        });

        if (!response.ok) return unknownKickStatus(channelId);

        const data = await response.json();
        return {
          isLive: data?.livestream !== null && data?.livestream !== undefined,
          viewerCount: data?.livestream?.viewer_count || 0,
          channelId: data?.slug || channelId,
          status: 'ok' as const,
        };
      });

      res.json(result);
    } catch (error) {
      const unknown = unknownKickStatus(channelId);
      // Briefly cache failures too, so an outage does not cause a retry storm.
      kickStatusCache.set(channelId, unknown);
      res.json(unknown);
    }
  });

  app.post("/api/stream/validate", async (req, res) => {
    const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
      return res.status(400).json({ valid: false, reason: "Invalid video ID" });
    }
    if (!youtubeVideoRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ valid: false, reason: "Too many YouTube checks, slow down" });
    }

    if (!apiKey) {
      return res.status(503).json({ valid: true, reason: "API key not configured - assuming valid" });
    }

    try {
      const details = await getVideoDetails(videoId, apiKey);

      if (!details) {
        return res.json({ valid: false, reason: "Video not found" });
      }

      if (isMusicCategory(details.categoryId)) {
        return res.json({ valid: false, reason: "Music category (filtered)" });
      }

      if (!details.isEmbeddable) {
        return res.json({ valid: false, reason: "Not embeddable" });
      }

      res.json({
        valid: true,
        channelId: details.channelId,
        isLive: details.liveBroadcastContent === 'live'
      });
    } catch (error) {
      sendInternalError(req, res, error, { valid: false });
    }
  });

  // Personal-library data belongs to the signed-in Supabase user. The old
  // Replit session middleware was removed, so verify the Bearer token here.
  app.use("/api/library", attachSupabaseUser);

  app.get("/api/library", async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const library = await storage.getUserLibrary(userId);
      res.json({ items: library });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.post("/api/library", async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const validation = insertUserLibrarySchema.safeParse({ ...req.body, userId });

      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const item = await storage.addToLibrary(validation.data);
      res.json({ item });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.delete("/api/library/:id", async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;
    const id = req.params.id as string;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const deleted = await storage.removeFromLibrary(id, userId);
      res.json({ success: deleted });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.patch("/api/library/:id", async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;
    const id = req.params.id as string;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const validation = updateUserLibrarySchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const updated = await storage.updateLibraryItem(id, userId, validation.data);

      if (!updated) {
        return res.status(404).json({ error: "Item not found" });
      }

      res.json({ item: updated });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // Cloud-sync of the user's dashboard layout. Available to every signed-in
  // user (OpenBento is fully free). Auth is provided by the Supabase Bearer
  // token attached by `attachSupabaseUser`.
  app.get("/api/dashboard", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const dashboard = await storage.getDashboard(userId);
      res.json({ dashboard });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.post("/api/dashboard", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const validation = insertDashboardSchema.safeParse({ ...req.body, userId });

      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const dashboard = await storage.saveDashboard(validation.data);
      res.json({ dashboard });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.patch("/api/dashboard", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = (req as any).userId || (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const validation = updateDashboardSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const dashboard = await storage.updateDashboard(userId, validation.data);

      if (!dashboard) {
        return res.status(404).json({ error: "Dashboard not found" });
      }

      res.json({ dashboard });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // Admin Channel Management Routes
  const isAdmin = (req: Request): boolean => {
    const user = (req as any).user;
    const email = user?.email;
    const isAdminUser = isAdminEmail(email || '');
    return isAdminUser;
  };

  // The main app signs users in through Supabase. Verify that same Supabase
  // access token before any admin route checks the user's email.
  app.use("/api/admin", attachSupabaseUser);

  app.post("/api/admin/links/refresh", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const data = await refreshAllLinks();
      res.json({ success: true, channelCount: data.channels.length, lastRefresh: data.lastRefresh });
    } catch (error) {
      sendInternalError(req, res, error, { success: false });
    }
  });

  app.get("/api/admin/channels", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const channels = await storage.getAllChannels();
      res.json({ channels });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.post("/api/admin/channels", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const validation = insertChannelSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const channel = await storage.createChannel(validation.data);
      res.json({ channel });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.patch("/api/admin/channels/:id", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const id = decodeURIComponent(req.params.id as string);
      if (/[\/\\]/.test(id)) {
        return res.status(400).json({ error: "Channel ID must not contain slashes" });
      }
      const body = req.body;
      const sanitized: Record<string, any> = {};
      if (body.name !== undefined) sanitized.name = body.name;
      if (body.channelHandle !== undefined) sanitized.channelHandle = body.channelHandle;
      if (body.platform !== undefined) sanitized.platform = body.platform;
      if (body.iconType !== undefined) sanitized.iconType = body.iconType;
      if (body.category !== undefined) sanitized.category = body.category;
      if (body.videoId !== undefined) sanitized.videoId = body.videoId;
      if (body.url !== undefined) sanitized.url = body.url;
      if (body.logoUrl !== undefined) sanitized.logoUrl = body.logoUrl;
      if (body.isLive !== undefined) sanitized.isLive = body.isLive;
      if (body.isManualOverride !== undefined) sanitized.isManualOverride = body.isManualOverride;
      if (body.isVisible !== undefined) sanitized.isVisible = body.isVisible;
      if (body.rank !== undefined) sanitized.rank = body.rank;

      const channel = await storage.updateChannel(id, sanitized);

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.json({ channel });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.delete("/api/admin/channels/:id", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const id = decodeURIComponent(req.params.id as string);
      if (/[\/\\]/.test(id)) {
        return res.status(400).json({ error: "Channel ID must not contain slashes" });
      }
      const deleted = await storage.deleteChannel(id);

      if (!deleted) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.json({ success: true });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.post("/api/admin/channels/reorder", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const { updates } = req.body;
      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: "updates must be a non-empty array of { id, rank }" });
      }
      for (const item of updates) {
        if (!item || typeof item.id !== 'string' || typeof item.rank !== 'number' || !Number.isInteger(item.rank) || item.rank < 1) {
          return res.status(400).json({ error: `Invalid update entry: each must have string id and integer rank >= 1` });
        }
      }
      for (const { id, rank } of updates) {
        await storage.updateChannel(id, { rank });
      }
      res.json({ success: true });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // ✅ FEEDBACK ROUTE WITH 15-MINUTE COOLDOWN (KEPT)
  app.post("/api/feedback", async (req: Request, res: Response) => {
    try {
      const { category, description, email, type, message, userEmail, screenshot } = req.body;
      const normalizedBody: Record<string, unknown> = {
        type: type || category,
        message: message || description,
        userEmail: userEmail || email || null,
      };

      if (screenshot && typeof screenshot === 'string') {
        const screenshotValidation = validateFeedbackScreenshot(screenshot);
        if (!screenshotValidation.ok) {
          return res.status(400).json({ error: screenshotValidation.error });
        }
        normalizedBody.screenshot = screenshot;
      }

      const validation = insertFeedbackSchema.safeParse(normalizedBody);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.message });
      }

      const feedbackType = validation.data.type;
      if (feedbackType && !['bug', 'idea'].includes(feedbackType)) {
        return res.status(400).json({ error: "Type must be 'bug' or 'idea'" });
      }

      const feedbackMessage = validation.data.message;
      const feedbackEmail = validation.data.userEmail;

      // Get client IP for rate limiting
      const clientIp = getClientIp(req);

      try {
        const COOLDOWN_MINUTES = 15;
        const cooldownCheck = await storage.checkFeedbackCooldown(clientIp, COOLDOWN_MINUTES);
        if (!cooldownCheck.allowed) {
          const minutesLeft = Math.ceil(cooldownCheck.minutesRemaining || 0);
          return res.status(429).json({
            error: `Please wait ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} before submitting more feedback.`,
            retryAfter: cooldownCheck.minutesRemaining
          });
        }
      } catch (cooldownErr) {
        console.warn('[feedback] Cooldown check failed, allowing submission:', cooldownErr);
      }

      const item = await storage.createFeedback(validation.data);

      try {
        await storage.updateFeedbackCooldown(clientIp);
      } catch (cooldownErr) {
        console.warn('[feedback] Cooldown update failed:', cooldownErr);
      }

      // Send email notification
      try {
        const { client, fromEmail } = getResendClient();
        const categoryLabel = feedbackType === 'idea' ? 'New Idea' : 'Bug Report';
        const escapeHtml = (str: string) => str
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        const safeDescription = escapeHtml(feedbackMessage).replace(/\n/g, '<br />');
        const safeEmail = escapeHtml(feedbackEmail || 'Anonymous');

        await client.emails.send({
          from: fromEmail,
          to: 'support@openbento.tv',
          subject: `[OpenBento ${categoryLabel}] Feedback Received`,
          html: `
            <h2>OpenBento Feedback - ${categoryLabel}</h2>
            <p><strong>Category:</strong> ${categoryLabel}</p>
            <p><strong>From:</strong> ${safeEmail}</p>
            <p><strong>IP:</strong> ${clientIp}</p>
            <hr />
            <p><strong>Description:</strong></p>
            <p>${safeDescription}</p>
            <hr />
            <p style="color: #666; font-size: 12px;">Sent from OpenBento Feedback Form</p>
          `,
        });
        console.log(`[Feedback] Saved to DB + sent email for ${feedbackType} feedback from ${clientIp}`);
      } catch (emailError) {
        console.warn('[Feedback] Saved to DB but email failed:', emailError);
      }

      res.json({ success: true, feedback: item });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  app.get("/api/admin/feedback", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const items = await storage.getAllFeedback();
      res.json({ feedback: items });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // Migration endpoint - import channels from links.json to database
  app.post("/api/admin/migrate-channels", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const linksData = loadLinks();
      let imported = 0;

      for (const channel of linksData.channels) {
        const existing = await storage.getChannel(channel.id);
        if (!existing) {
          await storage.createChannel({
            id: channel.id,
            name: channel.name,
            channelHandle: channel.channelHandle,
            platform: channel.platform,
            iconType: channel.iconType,
            category: channel.category,
            videoId: channel.videoId,
            isLive: channel.isLive,
            lastUpdated: channel.lastUpdated ? new Date(channel.lastUpdated) : new Date(),
          });
          imported++;
        }
      }

      res.json({ success: true, imported, total: linksData.channels.length });
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // Admin Users API - Fetch all users from Supabase
  app.get("/api/admin/users", async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const supabaseUrl = process.env.VITE_SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!supabaseUrl || !serviceRoleKey) {
        return res.status(500).json({ error: "Supabase credentials not configured" });
      }

      // Create AbortController with 10-second timeout to prevent 504 errors
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        // Use Supabase Admin API to fetch users with timeout
        const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Admin] Supabase user fetch error:', errorText);
          return res.status(response.status).json({ error: 'Failed to fetch users from Supabase' });
        }

        const data = await response.json();

        // Map to simplified user objects for the admin panel
        const users = (data.users || []).map((user: any) => ({
          id: user.id,
          email: user.email,
          createdAt: user.created_at,
          lastSignIn: user.last_sign_in_at,
          emailConfirmed: user.email_confirmed_at ? true : false,
          provider: user.app_metadata?.provider || 'email',
        }));

        res.json({ users, total: users.length });
      } catch (fetchError: any) {
        clearTimeout(timeoutId);

        if (fetchError.name === 'AbortError') {
          console.error('[Admin] Supabase fetch timeout after 10 seconds');
          return res.status(504).json({ error: 'Request timeout - Supabase took too long to respond' });
        }
        throw fetchError;
      }
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });

  // ─── Weather API (OpenWeatherMap) ──────────────────────────────────────────
  // Supports lookup by city name (?city=London) OR coordinates (?lat=&lon=).
  // Coordinate lookup is preferred when the client has geolocation; the
  // response always includes lat/lon so the client can request the matching
  // forecast without a second geocoding round-trip.
  app.get('/api/weather', async (req: Request, res: Response) => {
    if (!publicDataRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many public data requests. Please try again later.' });
    }

    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Weather API key not configured' });
    }

    const lookupResult = parseWeatherLookup(req.query);
    if (!lookupResult.ok) return res.status(400).json({ error: lookupResult.error });
    const lookup = lookupResult.lookup;
    const cacheKey = `current:${weatherLookupCacheKey(lookup)}`;
    const cached = weatherCache.get(cacheKey);
    if (cached) return res.json(cached);

    let url: string;
    if (lookup.kind === 'coordinates') {
      url = `https://api.openweathermap.org/data/2.5/weather?lat=${lookup.lat}&lon=${lookup.lon}&appid=${apiKey}&units=metric`;
    } else {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(lookup.city)}&appid=${apiKey}&units=metric`;
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[Weather] OpenWeatherMap error ${resp.status}: ${body}`);
        return res.status(resp.status).json({ error: 'Weather service error' });
      }
      const data = await resp.json();
      const mapped = {
        city: data.name,
        lat: data.coord?.lat ?? (lookup.kind === 'coordinates' ? lookup.lat : null),
        lon: data.coord?.lon ?? (lookup.kind === 'coordinates' ? lookup.lon : null),
        tempC: Math.round(data.main.temp),
        tempF: Math.round(data.main.temp * 9 / 5 + 32),
        condition: data.weather?.[0]?.main || 'Unknown',
        description: data.weather?.[0]?.description || '',
        icon: mapOwmIcon(data.weather?.[0]?.icon || '01d'),
        humidity: data.main.humidity,
        windKph: Math.round((data.wind?.speed || 0) * 3.6),
      };
      weatherCache.set(cacheKey, mapped);
      res.json(mapped);
    } catch (err) {
      console.error('[Weather] Fetch error:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });

  // ─── Weather Forecast (OpenWeatherMap 5-day / 3-hour, aggregated to days) ─
  // Returns the next 3 days (excluding today) with min/max temps and the
  // representative icon. Accepts ?lat=&lon= or ?city=.
  app.get('/api/weather/forecast', async (req: Request, res: Response) => {
    if (!publicDataRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many public data requests. Please try again later.' });
    }

    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Weather API key not configured' });
    }

    const lookupResult = parseWeatherLookup(req.query);
    if (!lookupResult.ok) return res.status(400).json({ error: lookupResult.error });
    const lookup = lookupResult.lookup;
    const cacheKey = `forecast:${weatherLookupCacheKey(lookup)}`;
    const cached = weatherCache.get(cacheKey);
    if (cached) return res.json(cached);

    let url: string;
    if (lookup.kind === 'coordinates') {
      url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lookup.lat}&lon=${lookup.lon}&appid=${apiKey}&units=metric`;
    } else {
      url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(lookup.city)}&appid=${apiKey}&units=metric`;
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[Weather Forecast] OpenWeatherMap error ${resp.status}: ${body}`);
        return res.status(resp.status).json({ error: 'Weather service error' });
      }
      const data = await resp.json();
      const list: any[] = Array.isArray(data.list) ? data.list : [];

      const tzOffsetSec: number = data.city?.timezone ?? 0;
      // ── "today" must also be expressed in the city's local time, otherwise
      //    cities far from UTC can incorrectly drop or include a day.
      const nowLocalMs = (Math.floor(Date.now() / 1000) + tzOffsetSec) * 1000;
      const today = new Date(nowLocalMs).toISOString().slice(0, 10);

      const buckets = new Map<string, { temps: number[]; icons: string[]; conditions: string[]; midday?: any }>();
      for (const entry of list) {
        const localMs = (entry.dt + tzOffsetSec) * 1000;
        const dateKey = new Date(localMs).toISOString().slice(0, 10);
        if (dateKey === today) continue;
        let bucket = buckets.get(dateKey);
        if (!bucket) {
          bucket = { temps: [], icons: [], conditions: [] };
          buckets.set(dateKey, bucket);
        }
        bucket.temps.push(entry.main?.temp ?? 0);
        bucket.icons.push(entry.weather?.[0]?.icon ?? '01d');
        bucket.conditions.push(entry.weather?.[0]?.main ?? 'Unknown');
        const hourLocal = new Date(localMs).getUTCHours();
        if (hourLocal === 12 || (!bucket.midday && hourLocal >= 11 && hourLocal <= 14)) {
          bucket.midday = entry;
        }
      }

      const sortedDates = Array.from(buckets.keys()).sort().slice(0, 3);
      const days = sortedDates.map((dateKey) => {
        const b = buckets.get(dateKey)!;
        const tempMax = Math.max(...b.temps);
        const tempMin = Math.min(...b.temps);
        const repIcon = b.midday?.weather?.[0]?.icon || b.icons[Math.floor(b.icons.length / 2)] || '01d';
        const repCond = b.midday?.weather?.[0]?.main || b.conditions[Math.floor(b.conditions.length / 2)] || 'Unknown';
        const dayDate = new Date(`${dateKey}T12:00:00Z`);
        const dayLabel = dayDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        return {
          date: dateKey,
          dayLabel,
          tempMaxC: Math.round(tempMax),
          tempMinC: Math.round(tempMin),
          tempMaxF: Math.round(tempMax * 9 / 5 + 32),
          tempMinF: Math.round(tempMin * 9 / 5 + 32),
          icon: mapOwmIcon(repIcon),
          condition: repCond,
        };
      });

      const mapped = {
        city: data.city?.name ?? null,
        lat: data.city?.coord?.lat ?? (lookup.kind === 'coordinates' ? lookup.lat : null),
        lon: data.city?.coord?.lon ?? (lookup.kind === 'coordinates' ? lookup.lon : null),
        days,
      };
      weatherCache.set(cacheKey, mapped);
      res.json(mapped);
    } catch (err) {
      console.error('[Weather Forecast] Fetch error:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });

  function mapOwmIcon(owmIcon: string): string {
    if (owmIcon.startsWith('01')) return 'sun';
    if (owmIcon.startsWith('02') || owmIcon.startsWith('03')) return 'cloud';
    if (owmIcon.startsWith('04')) return 'cloudy';
    if (owmIcon.startsWith('09')) return 'cloud-drizzle';
    if (owmIcon.startsWith('10')) return 'cloud-rain';
    if (owmIcon.startsWith('11')) return 'cloud-lightning';
    if (owmIcon.startsWith('13')) return 'cloud-snow';
    if (owmIcon.startsWith('50')) return 'wind';
    return 'sun';
  }

  // ─── News API (NewsAPI.org) ───────────────────────────────────────────────
  // Accepts optional `?sources=bbc-news,reuters` (NewsAPI source IDs, comma-list)
  // and `?category=business|entertainment|general|health|science|sports|technology`.
  // Per NewsAPI rules, `sources` is mutually exclusive with `category` & `country` —
  // when sources are supplied we drop both and forward only sources. Otherwise we
  // forward category + language=en (default).
  const NEWS_VALID_CATEGORIES = new Set([
    'business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology',
  ]);

  app.get('/api/news', async (req: Request, res: Response) => {
    if (!publicDataRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many public data requests. Please try again later.' });
    }

    const apiKey = process.env.NEWS_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'News API key not configured' });
    }

    const rawSources = typeof req.query.sources === 'string' ? req.query.sources.trim() : '';
    const rawCategory = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : '';

    // Sanitize sources: NewsAPI source IDs are lowercase + dashes only.
    const sources = rawSources
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[a-z0-9-]+$/.test(s))
      .slice(0, 20)
      .join(',');

    const category = NEWS_VALID_CATEGORIES.has(rawCategory) ? rawCategory : '';
    const cacheKey = sources ? `sources:${sources}` : `category:${category || 'general'}`;
    const cached = newsCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      const params = new URLSearchParams();
      if (sources) {
        params.set('sources', sources);
      } else {
        params.set('language', 'en');
        if (category) params.set('category', category);
      }
      params.set('apiKey', apiKey);
      const url = `https://newsapi.org/v2/top-headlines?${params.toString()}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[News] NewsAPI error ${resp.status}: ${body}`);
        return res.status(resp.status).json({ error: 'News service error' });
      }
      const data = await resp.json();
      const articles = (data.articles || [])
        .filter((a: any) => a.title && a.title !== '[Removed]')
        .slice(0, 20)
        .map((a: any, i: number) => ({
          id: i + 1,
          text: a.title,
          source: a.source?.name || '',
          url: a.url || '',
        }));
      const mapped = { articles };
      newsCache.set(cacheKey, mapped);
      res.json(mapped);
    } catch (err) {
      console.error('[News] Fetch error:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });

  // ─── Markets API (CoinGecko + Twelve Data) ────────────────────────────────
  // GET /api/markets?symbols=BTC,ETH,SPY,AAPL
  // Returns { symbols: [{ symbol, name, type, price, change24hPct, sparkline,
  //   updatedAt, error? }] }. Implementation lives in `server/markets.ts` so
  //   the cache, stale-fallback, and per-symbol error handling can be unit
  //   tested in isolation; this handler stays thin and only owns request
  //   parsing + the unexpected-error 5xx path.
  const marketsService = createMarketsService();
  // Re-exported for legacy references; kept for backward compatibility with
  // anything that imported `MARKETS_CACHE` from this module.
  const MARKETS_CACHE = marketsService.cache;

  // Legacy inline implementation removed — see `server/markets.ts`.
  // Suppress unused-binding warning on the legacy alias preserved above.
  void MARKETS_CACHE;

  app.get('/api/markets', async (req: Request, res: Response) => {
    if (!publicDataRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many public data requests. Please try again later.' });
    }

    const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
    const symbols = parseMarketsSymbols(raw);
    if (symbols.length === 0) {
      return res.status(400).json({ error: 'No valid symbols provided' });
    }
    try {
      const entries = await marketsService.getMarketEntries(symbols);
      res.json({ symbols: entries, fetchedAt: Date.now() });
    } catch (err) {
      console.error('[Markets] Unexpected error:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });

  // ─── GitHub Pulse API ──────────────────────────────────────────────────────
  // GET /api/github/repo/:owner/:repo
  // Returns { fullName, stars, openPRs, lastCommit:{sha,message,authoredAt,url},
  //   latestRelease:{tagName,name,publishedAt,url}, htmlUrl, fetchedAt }.
  // Public-data only. Cached in-memory for 5 minutes per owner/repo.
  type GitHubPulse = {
    fullName: string;
    htmlUrl: string;
    description: string | null;
    stars: number;
    openPRs: number;
    lastCommit: {
      sha: string;
      message: string;
      authoredAt: string;
      url: string;
    } | null;
    latestRelease: {
      tagName: string;
      name: string;
      publishedAt: string;
      url: string;
    } | null;
    fetchedAt: number;
  };

  // Bounded LRU + per-key in-flight de-dup. With many widget copies open,
  // this caps memory and collapses concurrent requests for the same repo
  // into a single upstream call so we don't burn through GitHub's rate
  // limit on dashboard load.
  const GITHUB_TTL_MS = 5 * 60 * 1000;
  const GITHUB_CACHE = new LruTtlCache<GitHubPulse>({ max: 500, ttlMs: GITHUB_TTL_MS });

  // Defined once at the closure level (not per-request) so that when
  // dedupe() shares a single rejected promise across concurrent callers,
  // every follower sees the same class identity and `instanceof` works.
  class GhStatusError extends Error {
    constructor(public status: number, public clientMessage: string) {
      super(clientMessage);
    }
  }
  // Owner / repo segments accepted by the GitHub API: alphanumerics, dots,
  // dashes, underscores, max 100 chars. Reject anything else outright so we
  // never make an upstream request for obvious junk.
  const GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

  app.get('/api/github/repo/:owner/:repo', async (req: Request, res: Response) => {
    const owner = String(req.params.owner ?? '').trim();
    const repo  = String(req.params.repo  ?? '').trim();
    if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
      return res.status(400).json({ error: 'Invalid owner or repo name' });
    }
    const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const fresh = GITHUB_CACHE.get(cacheKey);
    if (fresh) {
      return res.json(fresh);
    }
    if (!githubLookupRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many GitHub lookups. Please try again later.' });
    }
    // Stale entry kept around for fallback if upstream fails or rate-limits.
    const stale = GITHUB_CACHE.get(cacheKey, true);

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'OpenBento-Dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    try {
      const pulse = await GITHUB_CACHE.dedupe(cacheKey, async () => {
        const now = Date.now();
      // PR count uses the search API to get a real total without paging.
      const [repoResp, commitsResp, prResp, releaseResp] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(8_000) }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, { headers, signal: AbortSignal.timeout(8_000) }),
        fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:pr is:open`)}&per_page=1`, { headers, signal: AbortSignal.timeout(8_000) }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(8_000) }),
      ]);

      if (repoResp.status === 404) {
        throw new GhStatusError(404, 'Repository not found');
      }
      if (repoResp.status === 403) {
        throw new GhStatusError(429, 'GitHub rate limit reached, try again shortly');
      }
      if (!repoResp.ok) {
        throw new GhStatusError(502, `GitHub error ${repoResp.status}`);
      }

      type GhRepoFull = {
        full_name?: unknown; html_url?: unknown; description?: unknown;
        stargazers_count?: unknown;
      };
      type GhCommit = {
        sha?: unknown; html_url?: unknown;
        commit?: {
          message?: unknown;
          author?: { date?: unknown };
          committer?: { date?: unknown };
        };
      };
      type GhPrSearch = { total_count?: unknown };
      type GhRelease = {
        tag_name?: unknown; name?: unknown; published_at?: unknown; html_url?: unknown;
      };

      const repoData    = (await repoResp.json()) as GhRepoFull;
      const commitsJson: unknown = commitsResp.ok ? await commitsResp.json() : [];
      const commitsData: GhCommit[] = Array.isArray(commitsJson) ? (commitsJson as GhCommit[]) : [];
      const prData      = (prResp.ok ? await prResp.json() : { total_count: 0 }) as GhPrSearch;
      // Releases endpoint 404s when no releases exist — treat as "no release".
      const releaseData = (releaseResp.ok ? await releaseResp.json() : null) as GhRelease | null;

      const firstCommit = commitsData[0] ?? null;
      const releaseTag = typeof releaseData?.tag_name === 'string' ? releaseData.tag_name : '';

      const pulse: GitHubPulse = {
        fullName: typeof repoData.full_name === 'string' ? repoData.full_name : `${owner}/${repo}`,
        htmlUrl:  typeof repoData.html_url === 'string' ? repoData.html_url : `https://github.com/${owner}/${repo}`,
        description: typeof repoData.description === 'string' ? repoData.description : null,
        stars:   Number(repoData.stargazers_count ?? 0),
        openPRs: Number(prData.total_count ?? 0),
        lastCommit: firstCommit ? {
          sha:  (typeof firstCommit.sha === 'string' ? firstCommit.sha : '').slice(0, 7),
          message: (typeof firstCommit.commit?.message === 'string' ? firstCommit.commit.message : '')
            .split('\n')[0].slice(0, 200),
          authoredAt: String(
            firstCommit.commit?.author?.date ||
            firstCommit.commit?.committer?.date ||
            ''
          ),
          url: typeof firstCommit.html_url === 'string' ? firstCommit.html_url : '',
        } : null,
        latestRelease: releaseData && releaseTag ? {
          tagName:     releaseTag,
          name:        typeof releaseData.name === 'string' ? releaseData.name : releaseTag,
          publishedAt: typeof releaseData.published_at === 'string' ? releaseData.published_at : '',
          url:         typeof releaseData.html_url === 'string' ? releaseData.html_url : '',
        } : null,
        fetchedAt: now,
      };

        return pulse;
      });
      res.json(pulse);
    } catch (err: unknown) {
      if (err instanceof GhStatusError) {
        // 404 is definitive — never fall back to stale data for a different
        // repo name. Other status errors fall back to stale if we have it.
        if (err.status !== 404 && stale) return res.json(stale);
        return res.status(err.status).json({ error: err.clientMessage });
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GitHub Pulse] Fetch failed:', msg);
      if (stale) return res.json(stale);
      res.status(503).json({ error: 'GitHub temporarily unavailable' });
    }
  });

  // ─── GitHub Pulse — Owner / Profile Mode ───────────────────────────────────
  // GET /api/github/user/:owner
  // Returns the user/org profile plus top 5 public repos by stars. Same
  // 5-min cache + stale-on-error behavior as the repo route. Used when the
  // widget is configured with just an owner (no repo).
  type GitHubUserPulse = {
    login: string;
    name: string | null;
    htmlUrl: string;
    avatarUrl: string;
    bio: string | null;
    publicRepos: number;
    followers: number;
    following: number;
    topRepos: { name: string; stars: number; htmlUrl: string; description: string | null }[];
    fetchedAt: number;
  };
  const GITHUB_USER_CACHE = new LruTtlCache<GitHubUserPulse>({ max: 500, ttlMs: GITHUB_TTL_MS });

  app.get('/api/github/user/:owner', async (req: Request, res: Response) => {
    const owner = String(req.params.owner ?? '').trim();
    if (!GITHUB_NAME_RE.test(owner)) {
      return res.status(400).json({ error: 'Invalid owner name' });
    }
    const cacheKey = owner.toLowerCase();
    const fresh = GITHUB_USER_CACHE.get(cacheKey);
    if (fresh) return res.json(fresh);
    if (!githubLookupRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many GitHub lookups. Please try again later.' });
    }
    const stale = GITHUB_USER_CACHE.get(cacheKey, true);

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'OpenBento-Dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    try {
      const pulse = await GITHUB_USER_CACHE.dedupe(cacheKey, async () => {
        const now = Date.now();
      const [userResp, reposResp] = await Promise.all([
        fetch(`https://api.github.com/users/${owner}`, { headers, signal: AbortSignal.timeout(8_000) }),
        fetch(`https://api.github.com/users/${owner}/repos?type=owner&sort=updated&per_page=30`, { headers, signal: AbortSignal.timeout(8_000) }),
      ]);
      if (userResp.status === 404) {
        throw new GhStatusError(404, 'User or organization not found');
      }
      if (userResp.status === 403) {
        throw new GhStatusError(429, 'GitHub rate limit reached, try again shortly');
      }
      if (!userResp.ok) {
        throw new GhStatusError(502, `GitHub error ${userResp.status}`);
      }
      // Narrowly-typed shapes for the GitHub REST fields we actually consume.
      // Everything else from the upstream response is ignored.
      type GhUserApi = {
        login?: unknown; name?: unknown; html_url?: unknown; avatar_url?: unknown;
        bio?: unknown; public_repos?: unknown; followers?: unknown; following?: unknown;
      };
      type GhRepoApi = {
        name?: unknown; stargazers_count?: unknown; html_url?: unknown;
        description?: unknown; fork?: unknown;
      };
      const userData = (await userResp.json()) as GhUserApi;
      const reposJson: unknown = reposResp.ok ? await reposResp.json() : [];
      const reposData: GhRepoApi[] = Array.isArray(reposJson) ? (reposJson as GhRepoApi[]) : [];
      const topRepos = reposData
        .filter((r) => !r?.fork)
        .sort((a, b) => Number(b?.stargazers_count ?? 0) - Number(a?.stargazers_count ?? 0))
        .slice(0, 5)
        .map((r) => ({
          name:        typeof r.name === 'string' ? r.name : '',
          stars:       Number(r.stargazers_count ?? 0),
          htmlUrl:     typeof r.html_url === 'string' ? r.html_url : '',
          description: typeof r.description === 'string' ? r.description : null,
        }));

      const pulse: GitHubUserPulse = {
        login:       typeof userData.login === 'string' ? userData.login : owner,
        name:        typeof userData.name === 'string' ? userData.name : null,
        htmlUrl:     typeof userData.html_url === 'string' ? userData.html_url : `https://github.com/${owner}`,
        avatarUrl:   typeof userData.avatar_url === 'string' ? userData.avatar_url : '',
        bio:         typeof userData.bio === 'string' ? userData.bio : null,
        publicRepos: Number(userData.public_repos ?? 0),
        followers:   Number(userData.followers ?? 0),
        following:   Number(userData.following ?? 0),
        topRepos,
        fetchedAt: now,
      };
        return pulse;
      });
      res.json(pulse);
    } catch (err: unknown) {
      if (err instanceof GhStatusError) {
        if (err.status !== 404 && stale) return res.json(stale);
        return res.status(err.status).json({ error: err.clientMessage });
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GitHub Pulse user] Fetch failed:', msg);
      if (stale) return res.json(stale);
      res.status(503).json({ error: 'GitHub temporarily unavailable' });
    }
  });

  // ─── RSS Headlines API ──────────────────────────────────────────────────────
  // GET /api/rss?url=<feed_url>
  // Returns { title, link, items:[{title, url, pubDate, isoDate}], fetchedAt }.
  // Cached in-memory for 12 minutes per URL. Only http(s) URLs accepted.
  type RssPayload = {
    title: string;
    link: string;
    items: { title: string; url: string; pubDate: string; isoDate: string }[];
    fetchedAt: number;
  };
  const RSS_TTL_MS = 12 * 60 * 1000;
  const RSS_MAX_ITEMS = 30;
  // Bounded LRU + in-flight de-dup. Many widgets pointed at the same feed
  // share a single fetch; trivial URL variants (case in host, trailing
  // fragments) collapse to the same cache entry via normalizeFeedUrl().
  const RSS_CACHE = new LruTtlCache<RssPayload>({ max: 500, ttlMs: RSS_TTL_MS });

  // Normalize a feed URL so trivially-different inputs reuse the same cache
  // entry. We lowercase the protocol + host, strip the fragment (which is
  // never sent on the wire anyway), and drop a redundant default port. The
  // path/query are left intact — feeds are case-sensitive there.
  function normalizeFeedUrl(u: URL): string {
    const out = new URL(u.toString());
    out.protocol = out.protocol.toLowerCase();
    out.hostname = out.hostname.toLowerCase();
    out.hash = '';
    if (
      (out.protocol === 'http:'  && out.port === '80') ||
      (out.protocol === 'https:' && out.port === '443')
    ) {
      out.port = '';
    }
    return out.toString();
  }

  // SSRF guard: reject loopback, private, link-local, CGNAT, multicast,
  // and other non-public addresses (incl. 169.254.169.254 metadata).
  function isPrivateOrReservedIp(addr: string): boolean {
    const family = isIP(addr);
    if (family === 0) return true; // unknown — refuse
    if (family === 4) {
      const parts = addr.split('.').map(Number);
      if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
      const [a, b] = parts;
      if (a === 0)                                 return true; // 0.0.0.0/8
      if (a === 10)                                return true; // private
      if (a === 127)                               return true; // loopback
      if (a === 169 && b === 254)                  return true; // link-local + metadata
      if (a === 172 && b >= 16 && b <= 31)         return true; // private
      if (a === 192 && b === 168)                  return true; // private
      if (a === 100 && b >= 64 && b <= 127)        return true; // CGNAT
      if (a >= 224)                                return true; // multicast + reserved
      return false;
    }
    // IPv6 — strip zone id, lowercase
    const lower = addr.toLowerCase().split('%')[0];
    if (lower === '::1' || lower === '::')         return true; // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
    // fe80::/10 covers fe80:: through febf::
    if (/^fe[89ab]/.test(lower))                   return true;
    if (lower.startsWith('ff'))                    return true; // multicast
    // IPv4-mapped IPv6 (`::ffff:x.x.x.x`, `::ffff:0:x.x.x.x`, and the
    // collapsed hex form e.g. `::ffff:7f00:1` ≡ `::ffff:127.0.0.1`) is the
    // legitimate v4-in-v6 transition mechanism — recurse through IPv4 checks.
    const mapped = lower.match(/^::ffff(?::0)?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    const mappedHex = lower.match(/^::ffff(?::0)?:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateOrReservedIp(v4);
    }
    // Deprecated IPv4-compatible IPv6 (`::w.x.y.z`) is a legacy format with
    // no legitimate use today; block outright instead of recursing.
    if (/^::\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) return true;
    // Defense-in-depth: any other IPv6 containing a dot (embedded IPv4) we
    // can't classify is refused outright.
    if (lower.includes('.')) return true;
    return false;
  }

  app.get('/api/rss', async (req: Request, res: Response) => {
    const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!raw) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(raw);
    } catch {
      return res.status(400).json({ error: 'Malformed URL' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http(s) URLs are allowed' });
    }
    const cacheKey = normalizeFeedUrl(parsedUrl);
    const fresh = RSS_CACHE.get(cacheKey);
    if (fresh) {
      return res.json(fresh);
    }
    if (!rssLookupRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many feed lookups. Please try again later.' });
    }
    // SSRF guard helper: resolve hostname and verify EVERY A/AAAA record is
    // a public address. Hostnames that are themselves IP literals skip DNS.
    // Throws on failure with a stable message we surface to the caller.
    const validateHostIsPublic = async (hostname: string): Promise<void> => {
      const dns = await import('dns/promises');
      let targets: string[];
      if (isIP(hostname)) {
        targets = [hostname];
      } else {
        try {
          targets = (await dns.lookup(hostname, { all: true, family: 0 })).map(r => r.address);
        } catch (err: unknown) {
          const code = (err as { code?: string } | null)?.code || 'ENOTFOUND';
          throw new Error(`DNS lookup failed: ${code}`);
        }
      }
      if (targets.length === 0 || targets.some(isPrivateOrReservedIp)) {
        throw new Error('Refusing to fetch a private or reserved address');
      }
    };

    try {
      await validateHostIsPublic(parsedUrl.hostname);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Validation failed';
      return res.status(400).json({ error: msg });
    }
    const stale = RSS_CACHE.get(cacheKey, true);

    // Manual fetch with per-hop SSRF re-validation: rss-parser's parseURL
    // follows redirects unconditionally, so a public host could 30x into a
    // private IP. We follow ≤MAX_HOPS redirects and re-validate each hop.
    const MAX_HOPS = 5;
    const FETCH_TIMEOUT_MS = 10_000;
    const MAX_BODY_BYTES = 5 * 1024 * 1024;
    const safeFetchFeedBody = async (initialUrl: string): Promise<string> => {
      let currentUrl = initialUrl;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const u = new URL(currentUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('Redirect to non-HTTP scheme blocked');
        }
        await validateHostIsPublic(u.hostname);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        // Inferred return type of global `fetch` — avoid annotating with
        // `Response` because Express also exports a `Response` type and the
        // outer route handler shadows the DOM/global one.
        let resp: Awaited<ReturnType<typeof fetch>>;
        try {
          resp = await fetch(currentUrl, {
            redirect: 'manual',
            signal: ac.signal,
            headers: {
              'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app)',
              'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
            },
          });
        } finally {
          clearTimeout(timer);
        }
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc) throw new Error(`Redirect ${resp.status} without Location header`);
          // Resolve relative redirects against the current URL.
          currentUrl = new URL(loc, currentUrl).toString();
          continue;
        }
        if (!resp.ok) {
          throw new Error(`Upstream HTTP ${resp.status}`);
        }
        // Cap body size to avoid memory blow-ups from malicious/giant feeds.
        const reader = resp.body?.getReader();
        if (!reader) return await resp.text();
        const chunks: Uint8Array[] = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              try { await reader.cancel(); } catch { /* ignore */ }
              throw new Error('Feed body exceeds 5 MiB cap');
            }
            chunks.push(value);
          }
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
        return new TextDecoder('utf-8', { fatal: false }).decode(buf);
      }
      throw new Error(`Too many redirects (>${MAX_HOPS})`);
    };

    try {
      const payload = await RSS_CACHE.dedupe(cacheKey, async () => {
        // rss-parser is dynamically imported so the server boots even if
        // the dep is missing at startup; treat that as a soft 503.
        const Parser = (await import('rss-parser')).default;
        const parser = new Parser({
          timeout: 10_000,
          headers: { 'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app)' },
        });
        const body = await safeFetchFeedBody(cacheKey);
        const feed = await parser.parseString(body);
        const items = (feed.items || []).slice(0, RSS_MAX_ITEMS).map(it => ({
          title:   String(it.title    || '').trim(),
          url:     String(it.link     || '').trim(),
          pubDate: String(it.pubDate  || ''),
          isoDate: String(it.isoDate  || ''),
        })).filter(it => it.title.length > 0);
        const out: RssPayload = {
          title: String(feed.title || 'RSS Feed'),
          link:  String(feed.link  || cacheKey),
          items,
          fetchedAt: Date.now(),
        };
        return out;
      });
      res.json(payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[RSS] Fetch failed:', msg);
      if (stale) return res.json(stale);
      res.status(502).json({ error: 'Could not parse feed' });
    }
  });

  // ─── Network / Uptime Light API ─────────────────────────────────────────────
  // GET /api/ping?url=<target_url>
  // Returns { ok, status, latencyMs, fetchedAt }. SSRF-hardened identical to
  // /api/rss: http(s) only, public-IP DNS check on every redirect hop, manual
  // redirect handling capped at MAX_PING_HOPS, hard 5 s timeout. No caching —
  // freshness is the entire point of this widget.
  // ─── Air Quality (Open-Meteo, no key) ────────────────────────────
  // Free upstream — 15-min cache, 6-hour stale fallback, 7s timeout.
  // ?lat= & ?lon= required; optional ?pollen=1 enables the pollen series
  // (only meaningful for European latitudes — upstream returns null
  // elsewhere and the widget hides the row).
  const airQualityService = createAirQualityService();
  app.get('/api/air-quality', async (req: Request, res: Response) => {
    if (!publicDataRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many public data requests. Please try again later.' });
    }

    const pollen = req.query.pollen === '1' || req.query.pollen === 'true';
    let lat = Number(req.query.lat);
    let lon = Number(req.query.lon);
    let resolvedLabel: string | undefined;

    // Optional city resolution — when the caller supplies ?city= without
    // coords (or alongside them), we geocode via Open-Meteo's free API.
    // Coords still win when both are present and valid.
    const cityRaw = typeof req.query.city === 'string' ? req.query.city : '';
    if (cityRaw && (!Number.isFinite(lat) || !Number.isFinite(lon))) {
      const hit = await geocodeAirQualityCity(cityRaw);
      if (!hit) return res.status(404).json({ error: 'City not found' });
      lat = hit.lat; lon = hit.lon; resolvedLabel = hit.label;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ error: 'lat/lon (or ?city=) required and must be valid coordinates' });
    }
    try {
      const payload = await airQualityService.getAirQuality({ lat, lon, includePollen: pollen });
      res.json(resolvedLabel ? { ...payload, cityLabel: resolvedLabel } : payload);
    } catch (err) {
      console.error('[AirQuality] Fetch error:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });

  // ─── ISS Live Tracker ─────────────────────────────────────────────
  // Server proxy to wheretheiss.at (no key, public). Cached ~25s so the
  // upstream isn't hammered when many widgets refresh in parallel.
  interface IssPayload { lat: number; lon: number; altitudeKm: number | null; velocityKmh: number | null; ts: number; }
  const ISS_CACHE = new LruTtlCache<IssPayload>({ max: 1, ttlMs: 25_000 });
  // Next-overhead-pass estimator. Uses wheretheiss.at's `/positions`
  // endpoint, which accepts up to 10 timestamps per call and runs SGP4
  // server-side to predict ISS positions. We sample 20 points (two
  // batches) over the next ~95 minutes (one full orbit) and return the
  // timestamp of closest approach to the supplied (lat, lon).
  interface IssPassPayload { atTs: number; minDistanceKm: number; willPassOverhead: boolean; }
  const ISS_PASS_CACHE = new LruTtlCache<IssPassPayload>({ max: 64, ttlMs: 5 * 60_000 });
  app.get('/api/iss/pass', async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ error: 'lat/lon required and must be valid coordinates' });
    }
    const cacheKey = `${lat.toFixed(2)}:${lon.toFixed(2)}`;
    const cached = ISS_PASS_CACHE.get(cacheKey);
    if (cached) return res.json(cached);
    if (!issPassRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many ISS pass lookups. Please try again later.' });
    }

    // Sample every ~5 min over 95 min = 19 timestamps. Split into two
    // wheretheiss.at calls (10 ts max per request).
    const nowSec = Math.floor(Date.now() / 1000);
    const stepSec = 5 * 60;
    const totalPts = 19;
    const tsList = Array.from({ length: totalPts }, (_, i) => nowSec + i * stepSec);
    const batches: number[][] = [tsList.slice(0, 10), tsList.slice(10)];

    // Local haversine — keep server-side dependency-free.
    const haversine = (la1: number, lo1: number, la2: number, lo2: number): number => {
      const R = 6371;
      const dLat = (la2 - la1) * Math.PI / 180;
      const dLon = (lo2 - lo1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    };

    try {
      const positions: Array<{ ts: number; lat: number; lon: number }> = [];
      for (const batch of batches) {
        if (batch.length === 0) continue;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6_000);
        const url = `https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps=${batch.join(',')}`;
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
        const arr = await r.json() as Array<{ timestamp?: number; latitude?: number; longitude?: number }>;
        for (const p of arr) {
          if (typeof p.timestamp === 'number' && typeof p.latitude === 'number' && typeof p.longitude === 'number') {
            positions.push({ ts: p.timestamp, lat: p.latitude, lon: p.longitude });
          }
        }
      }
      if (positions.length === 0) {
        return res.status(502).json({ error: 'No upstream positions' });
      }
      let best = positions[0];
      let bestD = haversine(lat, lon, best.lat, best.lon);
      for (const p of positions.slice(1)) {
        const d = haversine(lat, lon, p.lat, p.lon);
        if (d < bestD) { bestD = d; best = p; }
      }
      const payload: IssPassPayload = {
        atTs: best.ts * 1000,
        minDistanceKm: bestD,
        // ISS visibility footprint is ~2000 km radius; below that the
        // station is at least theoretically above the local horizon.
        willPassOverhead: bestD < 2000,
      };
      ISS_PASS_CACHE.set(cacheKey, payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'ISS pass fetch failed' });
    }
  });

  // ─── Knowledge & Play pack ──────────────────────────────────────────────
  // GET /api/wordle/today — { date, answer } seeded from the shared
  // wordle-pool module so the client offline fallback can never drift.
  app.get('/api/wordle/today', (_req: Request, res: Response) => {
    const date = wordleUtcDateKey(new Date());
    res.json({ date, answer: pickDailyWordleAnswer(date) });
  });


  // GET /api/onthisday — Wikipedia REST `events` feed for today's MM/DD,
  // 1-hour cache (the upstream payload only changes once a day).
  interface OnThisDayEvent { year: number; text: string; pages: { title: string; url: string }[]; }
  interface OnThisDayPayload { date: string; events: OnThisDayEvent[]; fetchedAt: number; }
  const ONTHISDAY_CACHE = new LruTtlCache<OnThisDayPayload>({ max: 366, ttlMs: 60 * 60_000 });
  app.get('/api/onthisday', async (_req: Request, res: Response) => {
    const now = new Date();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const key = `${mm}/${dd}`;
    const cached = ONTHISDAY_CACHE.get(key);
    if (cached) return res.json(cached);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app)', 'Accept': 'application/json' },
      });
      if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
      const j = await r.json() as { events?: Array<{ year?: number; text?: string; pages?: Array<{ titles?: { normalized?: string }; title?: string; content_urls?: { desktop?: { page?: string } } }> }> };
      const events: OnThisDayEvent[] = (j.events || []).slice(0, 40).map(ev => ({
        year: typeof ev.year === 'number' ? ev.year : 0,
        text: String(ev.text || '').trim(),
        pages: (ev.pages || []).slice(0, 3).map(p => ({
          title: String(p.titles?.normalized || p.title || '').trim(),
          url: String(p.content_urls?.desktop?.page || ''),
        })).filter(p => p.title.length > 0),
      })).filter(ev => ev.text.length > 0 && ev.year > 0);
      const payload: OnThisDayPayload = { date: key, events, fetchedAt: Date.now() };
      ONTHISDAY_CACHE.set(key, payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'On This Day fetch failed' });
    } finally {
      clearTimeout(t);
    }
  });

  // GET /api/quote — proxies zenquotes.io. 5-min cache so a refresh-spam
  // user can't melt the upstream; the widget falls back to a bundled
  // pool when this endpoint is unavailable.
  interface QuotePayload { text: string; author: string; fetchedAt: number; }
  // Quote of the hour — cached for 1 hour so a refresh-spam user can't
  // hammer the upstream and so every client that polls hourly sees the
  // same quote during a given clock hour.
  const QUOTE_CACHE = new LruTtlCache<QuotePayload>({ max: 1, ttlMs: 60 * 60_000 });
  app.get('/api/quote', async (_req: Request, res: Response) => {
    const cached = QUOTE_CACHE.get('q');
    if (cached) return res.json(cached);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const r = await fetch('https://zenquotes.io/api/random', {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app)' },
      });
      if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
      const arr = await r.json() as Array<{ q?: string; a?: string }>;
      const first = Array.isArray(arr) ? arr[0] : null;
      if (!first || typeof first.q !== 'string') {
        return res.status(502).json({ error: 'Malformed upstream payload' });
      }
      const payload: QuotePayload = {
        text: first.q.trim(),
        author: typeof first.a === 'string' ? first.a.trim() : 'Unknown',
        fetchedAt: Date.now(),
      };
      QUOTE_CACHE.set('q', payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Quote fetch failed' });
    } finally {
      clearTimeout(t);
    }
  });

  // GET /api/trivia?difficulty=easy|medium|hard|any
  // "Question of the Hour" — proxies Open Trivia DB (no key), decodes
  // upstream HTML entities, returns a single MC question with its answer
  // index. Cached per-difficulty for 1 hour so every client that hits
  // this endpoint within the same clock hour gets the same question.
  interface TriviaPayload {
    question: string; choices: string[]; answerIdx: number;
    category: string; difficulty: string; fetchedAt: number;
  }
  const TRIVIA_CACHE = new LruTtlCache<TriviaPayload>({ max: 8, ttlMs: 60 * 60_000 });
  const decodeHtml = (s: string): string => s
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, '\u2019').replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c').replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026').replace(/&eacute;/g, '\u00e9')
    .replace(/&ntilde;/g, '\u00f1').replace(/&uuml;/g, '\u00fc')
    .replace(/&ouml;/g, '\u00f6').replace(/&auml;/g, '\u00e4');
  app.get('/api/trivia', async (req: Request, res: Response) => {
    const diff = String(req.query.difficulty ?? 'any');
    const allowed = new Set(['any', 'easy', 'medium', 'hard']);
    const difficulty = allowed.has(diff) ? diff : 'any';
    const cached = TRIVIA_CACHE.get(difficulty);
    if (cached) return res.json(cached);
    const params = new URLSearchParams({ amount: '1', type: 'multiple', encode: 'url3986' });
    if (difficulty !== 'any') params.set('difficulty', difficulty);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7_000);
    try {
      const r = await fetch(`https://opentdb.com/api.php?${params.toString()}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app)' },
      });
      if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
      const j = await r.json() as {
        response_code?: number;
        results?: Array<{
          category?: string; difficulty?: string; question?: string;
          correct_answer?: string; incorrect_answers?: string[];
        }>;
      };
      if (j.response_code !== 0 || !Array.isArray(j.results) || j.results.length === 0) {
        return res.status(502).json({ error: 'No question available' });
      }
      const q = j.results[0];
      const dec = (s?: string) => decodeHtml(decodeURIComponent(s || ''));
      const correct = dec(q.correct_answer);
      const incorrect = (q.incorrect_answers || []).map(dec);
      // Shuffle answers — Fisher-Yates with Math.random is fine here
      // (per-request randomness, not security-sensitive).
      const choices = [correct, ...incorrect];
      for (let i = choices.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [choices[i], choices[k]] = [choices[k], choices[i]];
      }
      const answerIdx = choices.indexOf(correct);
      const payload: TriviaPayload = {
        question: dec(q.question),
        choices, answerIdx,
        category: dec(q.category),
        difficulty: dec(q.difficulty),
        fetchedAt: Date.now(),
      };
      TRIVIA_CACHE.set(difficulty, payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Trivia fetch failed' });
    } finally {
      clearTimeout(t);
    }
  });

  app.get('/api/iss', async (_req: Request, res: Response) => {
    try {
      const cached = ISS_CACHE.get('iss');
      if (cached) return res.json(cached);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
      const j = await r.json() as { latitude?: number; longitude?: number; altitude?: number; velocity?: number };
      if (typeof j.latitude !== 'number' || typeof j.longitude !== 'number') {
        return res.status(502).json({ error: 'Malformed upstream payload' });
      }
      const payload: IssPayload = {
        lat: j.latitude,
        lon: j.longitude,
        altitudeKm: typeof j.altitude === 'number' ? j.altitude : null,
        velocityKmh: typeof j.velocity === 'number' ? j.velocity : null,
        ts: Date.now(),
      };
      ISS_CACHE.set('iss', payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'ISS fetch failed' });
    }
  });

  app.get('/api/ping', async (req: Request, res: Response) => {
    if (!publicPingRateLimit.allow(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many network checks, slow down' });
    }

    const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!raw) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(raw);
    } catch {
      return res.status(400).json({ error: 'Malformed URL' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http(s) URLs are allowed' });
    }
    const validateHostIsPublic = async (hostname: string): Promise<void> => {
      const dns = await import('dns/promises');
      let targets: string[];
      if (isIP(hostname)) {
        targets = [hostname];
      } else {
        try {
          targets = (await dns.lookup(hostname, { all: true, family: 0 })).map(r => r.address);
        } catch (err: unknown) {
          const code = (err as { code?: string } | null)?.code || 'ENOTFOUND';
          throw new Error(`DNS lookup failed: ${code}`);
        }
      }
      if (targets.length === 0 || targets.some(isPrivateOrReservedIp)) {
        throw new Error('Refusing to ping a private or reserved address');
      }
    };

    const MAX_PING_HOPS = 5;
    const PING_TIMEOUT_MS = 5_000;
    const t0 = Date.now();
    let currentUrl = parsedUrl.toString();
    let lastStatus = 0;
    try {
      for (let hop = 0; hop <= MAX_PING_HOPS; hop++) {
        const u = new URL(currentUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('Redirect to non-HTTP scheme blocked');
        }
        await validateHostIsPublic(u.hostname);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
        let resp: Awaited<ReturnType<typeof fetch>>;
        try {
          // HEAD first; many CDNs accept HEAD and it's cheap. Some sites 405
          // HEAD though, in which case we treat any HTTP response as "alive".
          resp = await fetch(currentUrl, {
            method: 'HEAD',
            redirect: 'manual',
            signal: ac.signal,
            headers: {
              'User-Agent': 'OpenBento-Dashboard/1.0 (+https://openbento.app) NetworkLight',
              'Accept': '*/*',
            },
          });
        } finally {
          clearTimeout(timer);
        }
        lastStatus = resp.status;
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc) break;
          currentUrl = new URL(loc, currentUrl).toString();
          continue;
        }
        break;
      }
      const latencyMs = Date.now() - t0;
      // 2xx / 3xx / 4xx all count as "host is alive". Only 5xx + network error
      // count as down. This matches uptime-monitor convention.
      const ok = lastStatus > 0 && lastStatus < 500;
      return res.json({ ok, status: lastStatus, latencyMs, fetchedAt: Date.now() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const latencyMs = Date.now() - t0;
      return res.json({
        ok: false,
        status: 0,
        latencyMs,
        fetchedAt: Date.now(),
        error: msg.slice(0, 200),
      });
    }
  });

  // Auto-import channels on startup (runs once)
  async function autoImportChannels() {
    try {
      const existingChannels = await storage.getAllChannels();
      if (existingChannels.length === 0) {
        console.log('[Startup] No channels found in database, auto-importing from links.json...');
        const linksData = loadLinks();
        let imported = 0;

        for (const channel of linksData.channels) {
          try {
            await storage.createChannel({
              id: channel.id,
              name: channel.name,
              channelHandle: channel.channelHandle,
              platform: channel.platform,
              iconType: channel.iconType,
              category: channel.category,
              videoId: channel.videoId,
              isLive: channel.isLive,
              lastUpdated: channel.lastUpdated ? new Date(channel.lastUpdated) : new Date(),
            });
            imported++;
          } catch (err) {
            // Skip duplicates silently
          }
        }

        console.log(`[Startup] Auto-imported ${imported} channels from links.json`);
      } else {
        console.log(`[Startup] Found ${existingChannels.length} channels in database, skipping auto-import`);
      }
    } catch (error) {
      console.error('[Startup] Error during auto-import:', error);
    }
  }

  // Run auto-import
  autoImportChannels();

  setupCastHub(httpServer, app);

  return httpServer;
}
