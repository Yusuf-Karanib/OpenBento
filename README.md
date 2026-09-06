# OpenBento

Free, ad-supported Mission Control dashboards for live streams, widgets, notes,
weather, markets, clocks, feeds, and personal utilities.

OpenBento is a customizable bento-style dashboard. It gives users a 12-column
workspace where they can add live video streams, utility widgets, notes, feeds,
themes, and multiple pages without needing an account. Signing in is optional
and only enables cross-device sync for layouts, themes, pages, and saved
libraries.

OpenBento is not a paid SaaS product. There is no premium tier, no paywall, and
no payment processing in the app.

## Live Demo

Live demo URL: `TODO: add deployed OpenBento URL`

If you are running the project locally, the development server serves the app at
`http://localhost:5000`.

## Screenshots

Add current screenshots or a short GIF before publishing the repository widely.

Suggested paths:

- `docs/screenshots/dashboard.png`
- `docs/screenshots/block-library.png`
- `docs/screenshots/themes.png`
- `docs/screenshots/cast.png`

Example Markdown once assets exist:

```md
![OpenBento dashboard](docs/screenshots/dashboard.png)
```

## Features

- 12-column bento dashboard grid with drag, resize, collision handling, and edit
  mode.
- Live video widgets for YouTube, Twitch, and Kick streams.
- Stream recovery and fallback behavior for YouTube live/offline states.
- Notes, images, spacers, clocks, world clocks, countdowns, weather, markets,
  RSS headlines, GitHub pulse, QR generation, dictionary, habit tracking, quick
  links, soundscapes, mood check-ins, sketch pad, and other utility widgets.
- Multi-page dashboards with per-page layout, theme, and background state.
- Local-first persistence for guests via `localStorage`.
- Optional Supabase-based sign-in for cross-device dashboard sync.
- Theme marketplace with built-in themes and personal saved themes.
- Command palette for adding widgets, switching pages, and common actions.
- Cast-to-TV flow for browser-equipped displays.
- Sandboxed custom widget runtime with a small postMessage SDK.
- Public feedback route for ideas and bug reports.

## Tech Stack

- React 18 and TypeScript
- Vite
- Wouter
- Tailwind CSS
- Radix UI primitives
- lucide-react icons
- `@dnd-kit` drag-and-drop
- TanStack Query
- Express 5
- PostgreSQL with Drizzle ORM
- Supabase authentication and PostgreSQL
- WebSocket support for cast features

## Quick Start

Prerequisites:

- Node.js
- npm
- PostgreSQL database URL for features that require persistence
- API keys for third-party widgets you plan to exercise locally

Install dependencies:

```bash
npm install
```

Create a local `.env` file for server-side variables and, if needed, a
`client/.env` file for client-exposed Vite variables. Do not commit either file.

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:5000
```

## Development Commands

```bash
npm run dev        # Start Express + Vite on port 5000
npm run build      # Build client to dist/public and server to dist/index.cjs
npm run start      # Run the production server
npm run check      # Run TypeScript type checking with no emit
npm test           # Run the automated test suite
npm run db:push    # Push Drizzle schema changes to PostgreSQL
```

Tests use Node's built-in test runner. Before opening a pull request, run:

```bash
npm run check
npm run build
npm test
```

## Environment Variables

The app reads environment variables from `.env` and `client/.env` during local
development. Keep all real values out of git.

Server-side variables:

```bash
SUPABASE_DATABASE_URL=
YOUTUBE_API_KEY=
WEATHER_API_KEY=
NEWS_API_KEY=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
SUPABASE_SERVICE_ROLE_KEY=
PORT=5000
```

Client-exposed Vite variables:

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Notes:

- In production, `SUPABASE_DATABASE_URL` must be a Supabase PostgreSQL connection string. `DATABASE_URL` remains available as a fallback outside Replit.
- `RESEND_FROM_EMAIL` must use a sender/domain verified in your Resend account.
- `VITE_*` variables are exposed to browser code. Only put public client values
  there.
- Server-only secrets such as database URLs, service role keys, and third-party
  API keys must remain server-side.
- Admin access is controlled by the allowlist in `shared/admin-access.ts`.
- Some widgets or routes degrade gracefully when optional upstream API keys are
  missing, but integrations that call those providers will not fully work.

## Project Structure

```text
client/                  React + Vite SPA
client/src/App.tsx       Providers and route table
client/src/dashboard/    Dashboard shell, sync, themes, page visuals
client/src/pages/        Route-level pages
client/src/widgets/      Widget model, registry, and widget components
client/src/components/   Shared UI and dashboard components
server/                  Express server and API routes
server/routes.ts         Main API route registration
server/storage.ts        Drizzle-backed storage layer
shared/                  Shared schemas, models, themes, page helpers, SDK types
shared/models/           Drizzle table definitions
mobile/                  Expo mobile companion app
```

Path aliases:

- `@/` maps to `client/src/`
- `@shared/` maps to `shared/`

## Widget Architecture

OpenBento widgets are persisted as JSON inside dashboard page state. The active
page is rendered into a 12 x 6 grid.

Important files:

- `client/src/widgets/shared.tsx` defines `WidgetType` and the persisted
  `Widget` shape.
- `client/src/widgets/registry.tsx` maps widget types to renderer components.
- `client/src/widgets/widget-renderer.tsx` dispatches widget rendering and shows
  an unknown-widget fallback.
- `client/src/components/widget-sidebar.tsx` defines Block Library widget
  templates and visible widget cards.
- `client/src/dashboard/dashboard-shell.tsx` owns dashboard state, placement,
  local persistence, and cloud sync wiring.
- `client/src/pages/dashboard.tsx` renders the grid, widget chrome, edit mode,
  resizing, fullscreen behavior, and video-specific controls.

Most widgets are self-contained React components under `client/src/widgets/`.
The video widget is the major exception: it is rendered inline through the
dashboard page because it needs iframe refs, seek-mode state, and platform
control hooks.

When adding a widget:

1. Add the widget type and persisted fields in `client/src/widgets/shared.tsx`.
2. Add the widget component under `client/src/widgets/`.
3. Register it in `client/src/widgets/registry.tsx`.
4. Add sidebar metadata in `client/src/components/widget-sidebar.tsx`.
5. Add defaults in `client/src/dashboard/dashboard-shell.tsx` only when needed.
6. Keep payloads JSON-serializable and backward compatible.

## Roadmap

Near-term areas that fit the current architecture:

- Improve first-run onboarding and starter dashboard packs.
- Add more focused, low-risk utility widgets.
- Improve widget discovery and Block Library organization.
- Expand custom widget SDK examples and documentation.
- Add screenshots and a hosted demo link to this README.
- Add automated tests for pure helpers and critical dashboard state behavior.
- Improve production chunking and bundle-size ergonomics.

Avoid roadmap items that introduce a premium tier or paywall; OpenBento should
remain free and ad-supported.

## Contributing

Contributions are welcome. Start with `CONTRIBUTING.md` for local setup,
branch naming, pull request expectations, and validation requirements.

Good first contributions are usually:

- Documentation improvements
- Small widget UI fixes
- New low-risk widget settings
- Accessibility improvements
- Focused bug fixes with clear reproduction steps

Please keep pull requests focused. Avoid mixing product changes, refactors,
database changes, and documentation changes in one PR unless they are tightly
related.

## Security and Secrets

Do not commit secrets, `.env` files, database URLs, API keys, Supabase service
role keys, or private tokens.

If you find a security issue, do not open a public issue with exploit details.
Use the repository owner's preferred private disclosure channel. If none is
listed yet, open a minimal issue asking for a security contact without including
sensitive details.

Custom widgets run in sandboxed iframes and communicate through a validated SDK
protocol. Keep that boundary intact when changing custom widget behavior.

## License

This project is declared as MIT licensed in `package.json`.

Before a public release, add a root `LICENSE` file containing the full MIT
license text so downstream users have an explicit license document.
