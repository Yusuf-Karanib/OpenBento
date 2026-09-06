// Thin wrappers around the existing OpenBento HTTP API. The mobile app
// is read+cast-only, so we only need a small subset:
//   - GET /api/dashboard            → fetch the user's pages
//   - GET /api/cast/rooms           → list paired BENTO-XXXX rooms
//   - POST /api/cast/rooms/:id/push → push a snapshot
//
// All calls send `Authorization: Bearer <supabase-access-token>`. The
// API base URL is provided at runtime via EXPO_PUBLIC_API_BASE_URL or
// `expo.extra.apiBaseUrl` (see README).

import { API_BASE_URL, getAccessToken } from './supabase';
import type { DashboardPage } from '../types';

const API_REQUEST_TIMEOUT_MS = 10_000;

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function authedFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(joinUrl(API_BASE_URL, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = (await res.text().catch(() => '')) || res.statusText;
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ── Dashboard ───────────────────────────────────────────────────────────
//
// The web app stores pages on the `dashboards` table. The server returns
// the row directly under `dashboard`. Older rows may not have `pages`
// populated (falling back to the legacy `widgets` array on the same row),
// so the fetcher normalizes to a `pages: DashboardPage[]` shape every
// time. If neither field is present we surface an empty page so the UI
// has something stable to render.

interface DashboardRow {
  pages?: unknown;
  activePageId?: unknown;
  widgets?: unknown;
  background?: string | null;
  isDarkMode?: boolean | null;
}

export interface DashboardSnapshot {
  pages: DashboardPage[];
  activePageId: string;
  isDarkMode: boolean;
  background: string;
}

function safePages(raw: unknown): DashboardPage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => {
      const r = p as Record<string, unknown>;
      const widgets = Array.isArray(r.widgets) ? (r.widgets as any[]) : [];
      return {
        id: typeof r.id === 'string' ? r.id : `page-${i}`,
        name: typeof r.name === 'string' ? r.name : `Page ${i + 1}`,
        isDefault: !!r.isDefault,
        widgets: widgets.filter((w) => w && typeof w === 'object'),
      };
    });
}

export async function fetchDashboard(): Promise<DashboardSnapshot> {
  const res = await authedFetch('GET', '/api/dashboard');
  const data = await jsonOrThrow<{ dashboard: DashboardRow | null }>(res);
  const row = data.dashboard ?? {};
  let pages = safePages(row.pages);
  // Legacy row — wrap the flat widgets array into a single Home page.
  if (pages.length === 0 && Array.isArray(row.widgets)) {
    pages = [
      {
        id: 'page-home',
        name: 'Home',
        isDefault: true,
        widgets: (row.widgets as any[]).filter((w) => w && typeof w === 'object'),
      },
    ];
  }
  if (pages.length === 0) {
    pages = [{ id: 'page-home', name: 'Home', isDefault: true, widgets: [] }];
  }
  const activeFromRow = typeof row.activePageId === 'string' ? row.activePageId : '';
  const activePageId =
    pages.find((p) => p.id === activeFromRow)?.id ??
    pages.find((p) => p.isDefault)?.id ??
    pages[0].id;
  return {
    pages,
    activePageId,
    isDarkMode: row.isDarkMode !== false, // default to dark if missing
    background: typeof row.background === 'string' ? row.background : '',
  };
}

// ── Cast ────────────────────────────────────────────────────────────────

export interface CastRoom {
  id: string;
  code: string | null;
  label: string;
  tvOnline: boolean;
  lastPushedAt: string | null;
  lastSeenAt: number | null;
}

export async function fetchCastRooms(): Promise<CastRoom[]> {
  const res = await authedFetch('GET', '/api/cast/rooms');
  const data = await jsonOrThrow<{ rooms: CastRoom[] }>(res);
  return Array.isArray(data.rooms) ? data.rooms : [];
}

export interface CastSnapshotPayload {
  v: 1;
  widgets: any[];
  isDarkMode: boolean;
  masterMute: boolean;
  background: string;
  pushedAt: number;
}

export function buildSnapshot(page: DashboardPage, isDarkMode: boolean, background = ''): CastSnapshotPayload {
  return {
    v: 1,
    widgets: page.widgets as any[],
    isDarkMode,
    masterMute: true,
    background,
    pushedAt: Date.now(),
  };
}

export async function pushCast(roomId: string, snapshot: CastSnapshotPayload): Promise<void> {
  const res = await authedFetch('POST', `/api/cast/rooms/${encodeURIComponent(roomId)}/push`, {
    snapshot,
  });
  await jsonOrThrow(res);
}
