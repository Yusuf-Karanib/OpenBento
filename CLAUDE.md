# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start development server (Express + Vite on port 5000)
npm run build      # Build production bundle (client → dist/public, server → dist/index.cjs)
npm run start      # Run production server
npm run check      # TypeScript type checking (no emit)
npm run db:push    # Push Drizzle schema changes to PostgreSQL
npm test           # Run the automated test suite
```

Tests use Node's built-in test runner through `npm test`.

## Architecture

**Monorepo** with three top-level directories sharing TypeScript paths (`@/` → `client/src/`, `@shared/` → `shared/`):

- `client/` — React 18 + Vite SPA
- `server/` — Express 5 API server (same port 5000 serves both API and static files)
- `shared/` — Drizzle ORM schemas and TypeScript types shared across client and server

### Database

Drizzle ORM with PostgreSQL. Schema files live in `shared/models/`:
- `auth.ts` — sessions, users, profiles tables
- `streams.ts` — dashboards, widgets, channels, feedback, streamStatusCache, healingLog

`shared/schema.ts` re-exports all models as a barrel. Use `npm run db:push` (not migrations) to apply schema changes.

### Authentication

Supabase is the only authentication system. The client signs users in through
`client/src/lib/supabase.ts`; protected server routes verify the Supabase Bearer
token through `server/services/supabaseAuth.ts`.

### Widget System

The dashboard (`client/src/App.tsx`) renders a **12-column bento grid** using `@dnd-kit` for drag-and-drop and resize. Widget types: `video`, `note`, `spacer`, `image`. Layout is persisted to localStorage (primary) and optionally synced to the server via `POST /api/dashboard`.

### Live Stream Pipeline

1. Widget sidebar searches YouTube via `/api/youtube/search-live/:channelHandle`
2. Returns `{ liveVideoId, latestVideoId, channelId }` — `latestVideoId` is the fallback when offline
3. Live status checks hit `/api/youtube/channel-live/:channelId` (YouTube Data API v3 `liveBroadcastContent` field)
4. Results are cached in localStorage with tiered TTLs: 30 min (online), 5 min (offline), 2 min (API error)
5. Stream healing (`POST /api/stream/heal`) re-searches for a live video and logs to `healingLog`

Twitch and Kick channels use their respective embed iframes directly (no API needed).

### Premium / Paywall

OpenBento is fully free and ad-supported. There is no premium tier, no paywall, and no payment processing. The dashboard is identical for guests and signed-in users; signing in only enables optional cross-device cloud sync of layouts/themes/pages.

### API Routes

All defined in `server/routes.ts`. Key groups:
- `/api/stream-status`, `/api/stream/heal`, `/api/youtube/*` — stream/media
- `/api/dashboard`, `/api/library` — user dashboard and channel library
- `/api/admin/*` — admin-only (gated by the allowlist in `shared/admin-access.ts`)
- `/api/weather`, `/api/news`, `/api/zoom/signature` — third-party widget data
- `/api/feedback` — public, no auth required

### Client Routing

Uses **Wouter** (not React Router). Routes defined in `client/src/App.tsx`:
- `/` — main dashboard
- `/admin` — admin panel
- `/auth/reset-password`, `/terms`, `/privacy`, `/feedback`

### Environment Variables

Required at runtime:
- `SUPABASE_DATABASE_URL` — Supabase PostgreSQL connection string in production
- `YOUTUBE_API_KEY`
- `WEATHER_API_KEY`, `NEWS_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (client-side)

Admin access is controlled by the code allowlist in `shared/admin-access.ts`, not
an environment variable.
