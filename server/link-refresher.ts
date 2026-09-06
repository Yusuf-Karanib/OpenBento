import * as fs from 'fs';
import * as path from 'path';
import { log } from './index';
import { applyYouTubeRefresh, type YouTubeRefreshResult } from './services/stream-refresh';

export interface LiveChannel {
  id: string;
  name: string;
  channelHandle: string;
  videoId: string | null;
  lastUpdated: number;
  platform: 'youtube' | 'twitch' | 'kick';
  iconType: 'news' | 'science' | 'finance' | 'gaming';
  category: string;
  isLive: boolean; // True for live streams (refresh every 10 min), false for normal videos (no refresh)
  isManualOverride?: boolean; // Admin locked - skip during background scrape
}

export interface LinksData {
  channels: LiveChannel[];
  lastRefresh: number;
}

// This version-controlled file is only a startup seed. Runtime refreshes must
// stay in memory so a running Replit app never dirties its Git checkout.
const LINKS_SEED_FILE_PATH = path.join(process.cwd(), 'server', 'data', 'links.json');
let runtimeLinks: LinksData | null = null;


async function fetchYouTubeLiveVideoId(channelHandle: string): Promise<YouTubeRefreshResult> {
  try {
    const liveUrl = `https://www.youtube.com/@${channelHandle}/live`;
    log(`[LinkRefresher] Fetching live stream for @${channelHandle}...`);
    
    const response = await fetch(liveUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      log(`[LinkRefresher] Failed to fetch @${channelHandle}: ${response.status}`);
      return { videoId: null, isLive: false, apiError: true };
    }

    const html = await response.text();
    
    // Check if this is an active live broadcast using liveBroadcastContent marker
    const isLiveBroadcast = html.includes('"isLive":true') || 
                            html.includes('"liveBroadcastContent":"live"') ||
                            html.includes('"isLiveContent":true');
    
    const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (videoIdMatch && videoIdMatch[1]) {
      log(`[LinkRefresher] Found video ID for @${channelHandle}: ${videoIdMatch[1]} (isLive: ${isLiveBroadcast})`);
      return { videoId: videoIdMatch[1], isLive: isLiveBroadcast, apiError: false };
    }

    const canonicalMatch = html.match(/href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
    if (canonicalMatch && canonicalMatch[1]) {
      log(`[LinkRefresher] Found canonical video ID for @${channelHandle}: ${canonicalMatch[1]} (isLive: ${isLiveBroadcast})`);
      return { videoId: canonicalMatch[1], isLive: isLiveBroadcast, apiError: false };
    }

    log(`[LinkRefresher] No live stream found for @${channelHandle}`);
    return { videoId: null, isLive: false, apiError: false };
  } catch (error) {
    log(`[LinkRefresher] Error fetching @${channelHandle}: ${error}`);
    return { videoId: null, isLive: false, apiError: true };
  }
}

export function loadLinks(): LinksData {
  if (runtimeLinks) {
    return runtimeLinks;
  }

  try {
    if (fs.existsSync(LINKS_SEED_FILE_PATH)) {
      const data = fs.readFileSync(LINKS_SEED_FILE_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    log(`[LinkRefresher] Error loading links: ${error}`);
  }

  return {
    channels: [],
    lastRefresh: 0,
  };
}

export async function refreshAllLinks(): Promise<LinksData> {
  log('[LinkRefresher] Starting link refresh...');
  
  const existingData = loadLinks();
  const now = Date.now();
  const channels: LiveChannel[] = [];

  for (const channel of existingData.channels) {
    if (channel.isManualOverride) {
      channels.push({ ...channel, lastUpdated: now });
      log(`[LinkRefresher] SKIP manual override: ${channel.name}`);
      continue;
    }
    if (channel.platform === 'youtube' && channel.isLive) {
      const result = await fetchYouTubeLiveVideoId(channel.channelHandle);
      channels.push(applyYouTubeRefresh(channel, result, now));
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      channels.push({
        ...channel,
        lastUpdated: now,
      });
    }
  }

  const data: LinksData = {
    channels,
    lastRefresh: now,
  };

  runtimeLinks = data;
  log(`[LinkRefresher] Refresh complete. Updated ${channels.length} channels.`);
  
  return data;
}

export function getChannelUrl(channel: LiveChannel, origin: string): string {
  // Safely extract origin and hostname
  let safeOrigin = 'https://localhost';
  let safeHostname = 'localhost';
  
  try {
    const url = new URL(origin);
    safeOrigin = url.origin;
    safeHostname = url.hostname;
  } catch {
    // If origin parsing fails, try to extract hostname from the string
    const hostMatch = origin.match(/^https?:\/\/([^\/]+)/);
    if (hostMatch) {
      safeHostname = hostMatch[1];
      safeOrigin = `https://${safeHostname}`;
    }
  }

  if (channel.platform === 'youtube') {
    // If we have a videoId, use it directly in a watch URL (this allows extractYouTubeId to work)
    if (channel.videoId) {
      return `https://www.youtube.com/watch?v=${channel.videoId}`;
    }
    // Fallback to channel live URL
    return `https://www.youtube.com/@${channel.channelHandle}/live`;
  } else if (channel.platform === 'twitch') {
    return `https://www.twitch.tv/${channel.channelHandle}`;
  } else if (channel.platform === 'kick') {
    return `https://kick.com/${channel.channelHandle}`;
  }
  return '';
}
