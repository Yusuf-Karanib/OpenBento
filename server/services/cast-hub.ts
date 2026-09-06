// Cast Hub: HTTP + WebSocket relay backing the "Cast to TV" feature.
//
// Two pairing models live here:
//   • Guest 6-digit codes — in-memory only, 60s TTL. /codes + /pair routes.
//   • Persistent BENTO-XXXX codes for signed-in users — stored on
//     `cast_rooms.code`, never expire, owner-scoped CRUD under /api/cast/rooms.
//
// All persistent routes require a Supabase Bearer token via attachSupabaseUser
// and verify cast_rooms.user_id === requester. Guest pushes still work
// because legacy guest rooms have null user_id and any caller may push to
// them (roomId remains the secret, matching v1 behaviour).
import type { Express, Request, Response } from "express";
import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "../db";
import {
  castRooms,
  castSchedules,
  castLayouts,
  castSnapshotSchema,
  type CastSnapshot,
  type CastRoom,
} from "@shared/schema";
import { eq, and, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { attachSupabaseUser, getUserId } from "./supabaseAuth";
import { CastSocketTicketStore } from "./cast-socket-tickets";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limit";
import {
  isValidTimeZone,
  minutesUntilSchedule,
  scheduleMatches,
} from "./cast-schedule-time";

interface PendingCode {
  code: string;
  roomId: string;
  expiresAt: number;
}

interface RoomConn {
  ws: WebSocket;
  role: "tv" | "laptop";
}

const pendingCodes = new Map<string, PendingCode>();
const roomConns = new Map<string, Set<RoomConn>>();
const pendingRoomIds = new Set<string>();
const tvLastSeen = new Map<string, number>();
const laptopSocketTickets = new CastSocketTicketStore();

const CODE_TTL_MS = 60_000;
const SNAPSHOT_BYTES_LIMIT = 4 * 1024 * 1024;
const WS_MESSAGE_BYTES_LIMIT = 16 * 1024;
const CODE_RATE_WINDOW_MS = 60_000;
const CODE_RATE_MAX = 10;
const HEARTBEAT_INTERVAL_MS = 5_000;
const SCHEDULER_TICK_MS = 60_000;
const SCHEDULE_REFIRE_GUARD_MS = 6 * 24 * 60 * 60 * 1_000;
const codeCreationRateLimit = new FixedWindowRateLimiter({
  windowMs: CODE_RATE_WINDOW_MS,
  maxAttempts: CODE_RATE_MAX,
});
const pairAttemptRateLimit = new FixedWindowRateLimiter({
  windowMs: CODE_RATE_WINDOW_MS,
  maxAttempts: CODE_RATE_MAX,
});

// BENTO-XXXX uses base32-ish (no 0/O/1/I) for human transcription.
const STABLE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomBentoCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += STABLE_ALPHABET[Math.floor(Math.random() * STABLE_ALPHABET.length)];
  }
  return `BENTO-${suffix}`;
}

async function generateUniqueBentoCode(): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = randomBentoCode();
    const [existing] = await db
      .select({ id: castRooms.id })
      .from(castRooms)
      .where(eq(castRooms.code, code))
      .limit(1);
    if (!existing) return code;
  }
  throw new Error("Could not allocate unique cast code after 30 attempts");
}

function generateGuestCode(): string {
  let code: string;
  do {
    code = String(Math.floor(100_000 + Math.random() * 900_000));
  } while (pendingCodes.has(code));
  return code;
}

async function purgeExpiredCodes(): Promise<void> {
  const now = Date.now();
  const expired: string[] = [];
  pendingCodes.forEach((p, code) => {
    if (p.expiresAt <= now) expired.push(code);
  });
  for (const code of expired) {
    const p = pendingCodes.get(code);
    pendingCodes.delete(code);
    if (p && pendingRoomIds.has(p.roomId)) {
      pendingRoomIds.delete(p.roomId);
      try {
        // Only sweep guest rooms (user_id null). Persistent rooms must survive.
        await db
          .delete(castRooms)
          .where(and(eq(castRooms.id, p.roomId), isNull(castRooms.userId)));
      } catch (err: unknown) {
        console.error("[Cast] failed to GC unpaired room:", err);
      }
    }
  }
}

function requestIp(req: Request): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    .trim()
    .slice(0, 64);
  return forwarded || req.socket.remoteAddress || "unknown";
}

function broadcast(roomId: string, payload: unknown, exclude?: WebSocket): void {
  const set = roomConns.get(roomId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  set.forEach((conn) => {
    if (conn.ws === exclude) return;
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  });
}

function sendTo(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function tvCount(roomId: string): number {
  const set = roomConns.get(roomId);
  if (!set) return 0;
  let n = 0;
  set.forEach((c) => {
    if (c.role === "tv" && c.ws.readyState === WebSocket.OPEN) n++;
  });
  return n;
}

function broadcastPresenceToLaptops(roomId: string): void {
  const set = roomConns.get(roomId);
  if (!set) return;
  const count = tvCount(roomId);
  const lastSeenAt = tvLastSeen.get(roomId);
  const payload = JSON.stringify({
    type: "presence",
    tvOnline: count > 0,
    tvCount: count,
    lastSeenAt: lastSeenAt ?? null,
  });
  set.forEach((conn) => {
    if (conn.role !== "laptop") return;
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  });
}

function closeRoomConns(roomId: string, reason: string): void {
  const set = roomConns.get(roomId);
  if (!set) return;
  const msg = JSON.stringify({ type: "closed", reason });
  set.forEach((conn) => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(msg);
        conn.ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
  });
  roomConns.delete(roomId);
}

async function loadRoom(roomId: string): Promise<CastRoom | null> {
  const [room] = await db.select().from(castRooms).where(eq(castRooms.id, roomId)).limit(1);
  return room || null;
}

// Owner check: persistent rooms (userId set) MUST match the requester. Guest
// rooms (userId null) remain reachable by anyone holding the roomId — that's
// the v1 behaviour the spec asks us to preserve.
function ensureCanWrite(room: CastRoom, requesterUserId: string | null): boolean {
  if (!room.userId) return true; // guest room
  return room.userId === requesterUserId;
}

// Recompute and push the "Next: X in Ym" overlay payload to every TV in the
// room. Called after every schedule mutation and after the scheduler fires so
// the overlay never goes stale until reconnect.
async function broadcastNextScheduled(roomId: string): Promise<void> {
  try {
    const next = await computeNextScheduled(roomId);
    const set = roomConns.get(roomId);
    if (!set) return;
    const payload = JSON.stringify({ type: "next-scheduled", next });
    set.forEach((conn) => {
      if (conn.role !== "tv") return;
      if (conn.ws.readyState === WebSocket.OPEN) {
        try { conn.ws.send(payload); } catch { /* ignore */ }
      }
    });
  } catch (err) {
    console.error("[Cast] broadcastNextScheduled failed:", err);
  }
}

async function pushSnapshotToRoom(roomId: string, snapshot: CastSnapshot): Promise<boolean> {
  const approxBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (approxBytes > SNAPSHOT_BYTES_LIMIT) return false;
  const [updated] = await db
    .update(castRooms)
    .set({
      lastSnapshot: snapshot,
      lastPushedAt: new Date(),
      currentLayoutId: snapshot.layoutId ?? null,
    })
    .where(eq(castRooms.id, roomId))
    .returning({ id: castRooms.id });
  if (!updated) return false;
  broadcast(roomId, { type: "snapshot", snapshot });
  return true;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
// Tick once a minute. Each entry is checked in the time zone where its owner
// created it, so 09:00 stays 09:00 even when the server runs in UTC.
let lastSchedulerTickMinute = -1;
async function runSchedulerTick(now: Date = new Date()): Promise<number> {
  // Coalesce duplicate ticks within the same real minute.
  const minuteKey = Math.floor(now.getTime() / 60_000);
  if (minuteKey === lastSchedulerTickMinute) return 0;
  lastSchedulerTickMinute = minuteKey;

  const schedules = await db.select().from(castSchedules);
  const due = schedules.filter((entry) =>
    scheduleMatches(now, entry.dayOfWeek, entry.minuteOfDay, entry.timeZone),
  );
  let fired = 0;
  for (const entry of due) {
    try {
      // Claim this weekly occurrence before pushing it. The conditional update
      // lets only one server instance win and also prevents a repeated clock
      // hour from firing the same weekly entry twice.
      const refireCutoff = new Date(now.getTime() - SCHEDULE_REFIRE_GUARD_MS);
      const [claimed] = await db
        .update(castSchedules)
        .set({ lastFiredAt: now })
        .where(
          and(
            eq(castSchedules.id, entry.id),
            or(isNull(castSchedules.lastFiredAt), lt(castSchedules.lastFiredAt, refireCutoff)),
          ),
        )
        .returning({ id: castSchedules.id });
      if (!claimed) continue;

      const [layout] = await db
        .select()
        .from(castLayouts)
        .where(eq(castLayouts.id, entry.layoutId))
        .limit(1);
      if (!layout) continue;
      const snap = layout.snapshot as CastSnapshot;
      // Stamp the snapshot with the layout name so the TV overlay can show it.
      const stamped: CastSnapshot = {
        ...snap,
        layoutId: layout.id,
        layoutName: layout.name,
        pushedAt: Date.now(),
      };
      const ok = await pushSnapshotToRoom(entry.roomId, stamped);
      if (!ok) continue;
      // Refresh the TV overlay so "Next: …" reflects the new closest entry.
      await broadcastNextScheduled(entry.roomId);
      fired++;
    } catch (err) {
      console.error("[Cast scheduler] entry failed:", err);
    }
  }
  return fired;
}

// Exported for tests so they can step the scheduler deterministically.
export const __castSchedulerForTests = {
  run: runSchedulerTick,
  resetMinute: () => {
    lastSchedulerTickMinute = -1;
  },
  pushSnapshotToRoom,
};

// Compute next scheduled change for overlay. Returns minutes-until-next + name.
async function computeNextScheduled(roomId: string, now: Date = new Date()): Promise<
  { layoutName: string; inMinutes: number } | null
> {
  const rows = await db
    .select({
      id: castSchedules.id,
      dayOfWeek: castSchedules.dayOfWeek,
      minuteOfDay: castSchedules.minuteOfDay,
      timeZone: castSchedules.timeZone,
      layoutId: castSchedules.layoutId,
    })
    .from(castSchedules)
    .where(eq(castSchedules.roomId, roomId));
  if (rows.length === 0) return null;
  let bestDelta = Infinity;
  let bestLayoutId: string | null = null;
  for (const r of rows) {
    const delta = minutesUntilSchedule(now, r.dayOfWeek, r.minuteOfDay, r.timeZone);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestLayoutId = r.layoutId;
    }
  }
  if (!bestLayoutId) return null;
  const [layout] = await db
    .select({ name: castLayouts.name })
    .from(castLayouts)
    .where(eq(castLayouts.id, bestLayoutId))
    .limit(1);
  return layout ? { layoutName: layout.name, inMinutes: bestDelta } : null;
}

// ─── Validation schemas ─────────────────────────────────────────────────────
const createRoomBody = z.object({
  label: z.string().min(1).max(40).default("TV"),
});
const renameRoomBody = z.object({
  label: z.string().min(1).max(40),
});
const scheduleBody = z.object({
  layoutId: z.string().min(1).max(64),
  dayOfWeek: z.number().int().min(0).max(6),
  minuteOfDay: z.number().int().min(0).max(1439),
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone).default("UTC"),
});
const layoutBody = z.object({
  name: z.string().min(1).max(80),
  snapshot: castSnapshotSchema,
});

export function setupCastHub(httpServer: HttpServer, app: Express): void {
  // ── Guest 6-digit pairing (unchanged behaviour) ──────────────────────────
  app.post("/api/cast/codes", async (req: Request, res: Response): Promise<void | Response> => {
    if (!codeCreationRateLimit.allow(requestIp(req))) {
      return res.status(429).json({ error: "Too many pairing requests, slow down" });
    }
    await purgeExpiredCodes();
    try {
      const [room] = await db
        .insert(castRooms)
        .values({ label: "TV" })
        .returning({ id: castRooms.id, label: castRooms.label });
      if (!room?.id) {
        return res.status(500).json({ error: "Failed to create room" });
      }
      pendingRoomIds.add(room.id);
      const code = generateGuestCode();
      pendingCodes.set(code, {
        code,
        roomId: room.id,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      res.json({
        code,
        roomId: room.id,
        label: room.label,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
    } catch (err) {
      console.error("[Cast] /codes failed:", err);
      res.status(500).json({ error: "Failed to create cast room" });
    }
  });

  // Pair: accepts either the 6-digit guest code OR a BENTO-XXXX persistent
  // code. For BENTO codes the caller must be authenticated AND own the room.
  app.post("/api/cast/pair", attachSupabaseUser, async (req: Request, res: Response) => {
    await purgeExpiredCodes();
    const raw = String(req.body?.code ?? "").trim().toUpperCase();
    if (/^\d{6}$/.test(raw)) {
      if (!pairAttemptRateLimit.allow(requestIp(req))) {
        return res.status(429).json({ error: "Too many pairing attempts, slow down" });
      }
      const pending = pendingCodes.get(raw);
      if (!pending) return res.status(404).json({ error: "Code expired or invalid" });
      pendingCodes.delete(raw);
      pendingRoomIds.delete(pending.roomId);
      try {
        const [room] = await db
          .select({ id: castRooms.id, label: castRooms.label })
          .from(castRooms)
          .where(eq(castRooms.id, pending.roomId))
          .limit(1);
        if (!room) return res.status(404).json({ error: "Room no longer exists" });
        // If the pairing requester is signed-in, claim the guest room as a
        // persistent BENTO room so it survives restarts.
        const userId = getUserId(req);
        let code: string | null = null;
        if (userId) {
          code = await generateUniqueBentoCode();
          await db
            .update(castRooms)
            .set({ userId, code })
            .where(eq(castRooms.id, room.id));
        }
        broadcast(pending.roomId, { type: "paired", roomId: pending.roomId, label: room.label });
        return res.json({ roomId: room.id, label: room.label, code });
      } catch (err) {
        console.error("[Cast] /pair failed:", err);
        return res.status(500).json({ error: "Pairing failed" });
      }
    }
    if (/^BENTO-[A-Z0-9]{4}$/.test(raw)) {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Sign in to pair persistent codes" });
      const [room] = await db
        .select()
        .from(castRooms)
        .where(eq(castRooms.code, raw))
        .limit(1);
      if (!room) return res.status(404).json({ error: "Code not found" });
      if (room.userId !== userId) return res.status(403).json({ error: "Not your room" });
      broadcast(room.id, { type: "paired", roomId: room.id, label: room.label });
      return res.json({ roomId: room.id, label: room.label, code: room.code });
    }
    return res.status(400).json({ error: "Code must be 6 digits or BENTO-XXXX" });
  });

  // ── Persistent rooms (signed-in only) ────────────────────────────────────
  // List my rooms.
  app.get("/api/cast/rooms", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const rows = await db
      .select({
        id: castRooms.id,
        code: castRooms.code,
        label: castRooms.label,
        currentLayoutId: castRooms.currentLayoutId,
        lastPushedAt: castRooms.lastPushedAt,
      })
      .from(castRooms)
      .where(eq(castRooms.userId, userId));
    const enriched = rows.map((r) => ({
      ...r,
      tvOnline: tvCount(r.id) > 0,
      lastSeenAt: tvLastSeen.get(r.id) ?? null,
    }));
    res.json({ rooms: enriched });
  });

  // Create a new persistent room (used when the user adds a TV from settings
  // before the TV itself is plugged in — the BENTO code is shown to type on
  // the TV's pairing screen).
  app.post("/api/cast/rooms", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const parsed = createRoomBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Bad room shape" });
    const code = await generateUniqueBentoCode();
    const [room] = await db
      .insert(castRooms)
      .values({ userId, label: parsed.data.label, code })
      .returning();
    res.json({ room });
  });

  // Push: writes snapshot to room, broadcasts via WS. Owner-checked.
  app.post(
    "/api/cast/rooms/:id/push",
    attachSupabaseUser,
    async (req: Request, res: Response) => {
      const roomId = String(req.params.id ?? "").trim();
      if (!roomId) return res.status(400).json({ error: "Missing room id" });
      const parsed = castSnapshotSchema.safeParse(req.body?.snapshot);
      if (!parsed.success) return res.status(400).json({ error: "Invalid snapshot shape" });
      const room = await loadRoom(roomId);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (!ensureCanWrite(room, getUserId(req))) {
        return res.status(403).json({ error: "Not your room" });
      }
      const ok = await pushSnapshotToRoom(roomId, parsed.data);
      if (!ok) return res.status(413).json({ error: "Snapshot too large" });
      res.json({ ok: true, pushedAt: parsed.data.pushedAt });
    },
  );

  // Bulk push to many rooms in one call.
  app.post("/api/cast/push-many", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const ids: string[] = Array.isArray(req.body?.roomIds) ? req.body.roomIds.slice(0, 50) : [];
    const parsed = castSnapshotSchema.safeParse(req.body?.snapshot);
    if (!parsed.success) return res.status(400).json({ error: "Invalid snapshot shape" });
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      const room = await loadRoom(id);
      if (!room) { fail++; continue; }
      if (!ensureCanWrite(room, userId)) { fail++; continue; }
      const success = await pushSnapshotToRoom(id, parsed.data);
      if (success) ok++; else fail++;
    }
    res.json({ ok, fail });
  });

  app.patch("/api/cast/rooms/:id", attachSupabaseUser, async (req: Request, res: Response) => {
    const roomId = String(req.params.id ?? "").trim();
    const parsed = renameRoomBody.safeParse(req.body ?? {});
    if (!roomId) return res.status(400).json({ error: "Missing room id" });
    if (!parsed.success) return res.status(400).json({ error: "Label required" });
    const room = await loadRoom(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!ensureCanWrite(room, getUserId(req))) {
      return res.status(403).json({ error: "Not your room" });
    }
    const [updated] = await db
      .update(castRooms)
      .set({ label: parsed.data.label })
      .where(eq(castRooms.id, roomId))
      .returning({ id: castRooms.id, label: castRooms.label });
    if (!updated) return res.status(404).json({ error: "Room not found" });
    broadcast(roomId, { type: "renamed", label: updated.label });
    res.json({ roomId: updated.id, label: updated.label });
  });

  app.get("/api/cast/rooms/:id", attachSupabaseUser, async (req: Request, res: Response) => {
    const roomId = String(req.params.id ?? "").trim();
    if (!roomId) return res.status(400).json({ error: "Missing room id" });
    const room = await loadRoom(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    // Read is allowed for guest rooms by anyone (back-compat); for persistent
    // rooms only the owner.
    if (room.userId && room.userId !== getUserId(req)) {
      return res.status(403).json({ error: "Not your room" });
    }
    const tvOnline = tvCount(roomId) > 0;
    const lastSeenAt = tvLastSeen.get(roomId) ?? null;
    const next = await computeNextScheduled(roomId);
    res.json({
      id: room.id,
      label: room.label,
      code: room.code,
      currentLayoutId: room.currentLayoutId,
      lastPushedAt: room.lastPushedAt,
      tvOnline,
      lastSeenAt,
      next,
    });
  });

  // Browsers cannot add an Authorization header to WebSocket connections.
  // Give an owner a short-lived, one-use ticket instead of putting their
  // Supabase access token in the socket URL.
  app.post(
    "/api/cast/rooms/:id/socket-ticket",
    attachSupabaseUser,
    async (req: Request, res: Response) => {
      const roomId = String(req.params.id ?? "").trim();
      if (!roomId) return res.status(400).json({ error: "Missing room id" });
      const room = await loadRoom(roomId);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (!ensureCanWrite(room, getUserId(req))) {
        return res.status(403).json({ error: "Not your room" });
      }
      res.json(laptopSocketTickets.issue(roomId));
    },
  );

  app.delete("/api/cast/rooms/:id", attachSupabaseUser, async (req: Request, res: Response) => {
    const roomId = String(req.params.id ?? "").trim();
    if (!roomId) return res.status(400).json({ error: "Missing room id" });
    const room = await loadRoom(roomId);
    if (!room) {
      // Idempotent — closing a room that's already gone is success.
      closeRoomConns(roomId, "Room deleted");
      return res.json({ ok: true });
    }
    if (!ensureCanWrite(room, getUserId(req))) {
      return res.status(403).json({ error: "Not your room" });
    }
    // Cascade-delete schedules so a re-pair under the same id doesn't inherit
    // ghost schedules.
    await db.delete(castSchedules).where(eq(castSchedules.roomId, roomId));
    await db.delete(castRooms).where(eq(castRooms.id, roomId));
    closeRoomConns(roomId, "Room deleted");
    tvLastSeen.delete(roomId);
    res.json({ ok: true });
  });

  // ── Layouts ──────────────────────────────────────────────────────────────
  app.get("/api/cast/layouts", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const rows = await db.select().from(castLayouts).where(eq(castLayouts.userId, userId));
    res.json({ layouts: rows });
  });

  app.post("/api/cast/layouts", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const parsed = layoutBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Bad layout shape" });
    const [row] = await db
      .insert(castLayouts)
      .values({ userId, name: parsed.data.name, snapshot: parsed.data.snapshot })
      .returning();
    res.json({ layout: row });
  });

  app.delete("/api/cast/layouts/:id", attachSupabaseUser, async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const id = String(req.params.id ?? "").trim();
    const [row] = await db
      .select({ userId: castLayouts.userId })
      .from(castLayouts)
      .where(eq(castLayouts.id, id))
      .limit(1);
    if (!row) return res.status(404).json({ error: "Layout not found" });
    if (row.userId !== userId) return res.status(403).json({ error: "Not your layout" });
    // Detach any schedules referencing this layout.
    await db.delete(castSchedules).where(eq(castSchedules.layoutId, id));
    await db.delete(castLayouts).where(eq(castLayouts.id, id));
    res.json({ ok: true });
  });

  // ── Schedules (per room) ────────────────────────────────────────────────
  app.get(
    "/api/cast/rooms/:id/schedules",
    attachSupabaseUser,
    async (req: Request, res: Response) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const roomId = String(req.params.id ?? "").trim();
      const room = await loadRoom(roomId);
      if (!room || room.userId !== userId) {
        return res.status(404).json({ error: "Room not found" });
      }
      const rows = await db
        .select()
        .from(castSchedules)
        .where(eq(castSchedules.roomId, roomId));
      res.json({ schedules: rows });
    },
  );

  app.post(
    "/api/cast/rooms/:id/schedules",
    attachSupabaseUser,
    async (req: Request, res: Response) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const roomId = String(req.params.id ?? "").trim();
      const room = await loadRoom(roomId);
      if (!room || room.userId !== userId) {
        return res.status(404).json({ error: "Room not found" });
      }
      const parsed = scheduleBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Bad schedule shape" });
      // Validate the layout belongs to the same user.
      const [layout] = await db
        .select({ userId: castLayouts.userId })
        .from(castLayouts)
        .where(eq(castLayouts.id, parsed.data.layoutId))
        .limit(1);
      if (!layout || layout.userId !== userId) {
        return res.status(400).json({ error: "Unknown layout" });
      }
      const [row] = await db
        .insert(castSchedules)
        .values({
          roomId,
          userId,
          layoutId: parsed.data.layoutId,
          dayOfWeek: parsed.data.dayOfWeek,
          minuteOfDay: parsed.data.minuteOfDay,
          timeZone: parsed.data.timeZone,
        })
        .returning();
      await broadcastNextScheduled(roomId);
      res.json({ schedule: row });
    },
  );

  app.delete(
    "/api/cast/schedules/:id",
    attachSupabaseUser,
    async (req: Request, res: Response) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const id = String(req.params.id ?? "").trim();
      const [row] = await db
        .select({ userId: castSchedules.userId })
        .from(castSchedules)
        .where(eq(castSchedules.id, id))
        .limit(1);
      if (!row) return res.status(404).json({ error: "Schedule not found" });
      if (row.userId !== userId) return res.status(403).json({ error: "Not your schedule" });
      const [full] = await db
        .select({ roomId: castSchedules.roomId })
        .from(castSchedules)
        .where(eq(castSchedules.id, id))
        .limit(1);
      await db.delete(castSchedules).where(eq(castSchedules.id, id));
      if (full?.roomId) await broadcastNextScheduled(full.roomId);
      res.json({ ok: true });
    },
  );

  // Laptop sockets also require a short-lived, one-use ticket. TV sockets use
  // their unguessable room UUID as the device credential so existing paired
  // TVs can reconnect without a signed-in browser being present.
  // ── WebSocket hub at /ws/cast?roomId=XXX&role=tv|laptop ─────────────────
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MESSAGE_BYTES_LIMIT,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!request.url) return;
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/ws/cast")) return;

    const roomId = url.searchParams.get("roomId");
    const role = url.searchParams.get("role");
    if (!roomId || (role !== "tv" && role !== "laptop")) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (role === "laptop") {
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!ticket || !laptopSocketTickets.consume(ticket, roomId)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, { roomId, role });
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: unknown, ctx: { roomId: string; role: "tv" | "laptop" }) => {
      const { roomId, role } = ctx;
      let set = roomConns.get(roomId);
      if (!set) {
        set = new Set();
        roomConns.set(roomId, set);
      }
      const conn: RoomConn = { ws, role };
      set.add(conn);

      if (role === "tv") tvLastSeen.set(roomId, Date.now());

      let isAlive = true;
      ws.on("pong", () => {
        isAlive = true;
        if (role === "tv") tvLastSeen.set(roomId, Date.now());
      });
      const heartbeat = setInterval(() => {
        if (!isAlive) {
          try { ws.terminate(); } catch { /* ignore */ }
          return;
        }
        isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      sendTo(ws, { type: "hello", role });

      db.select({
        lastSnapshot: castRooms.lastSnapshot,
        label: castRooms.label,
      })
        .from(castRooms)
        .where(eq(castRooms.id, roomId))
        .limit(1)
        .then(async (rows) => {
          const row = rows[0];
          if (!row) {
            sendTo(ws, { type: "closed", reason: "Room not found" });
            tvLastSeen.delete(roomId);
            try { ws.close(1000, "Room not found"); } catch { /* ignore */ }
            return;
          }
          if (row.label) sendTo(ws, { type: "renamed", label: row.label });
          if (role === "tv" && row.lastSnapshot) {
            sendTo(ws, { type: "snapshot", snapshot: row.lastSnapshot });
          }
          if (role === "tv") {
            const next = await computeNextScheduled(roomId).catch(() => null);
            if (next) sendTo(ws, { type: "next-scheduled", next });
          }
          if (role === "laptop") {
            sendTo(ws, {
              type: "presence",
              tvOnline: tvCount(roomId) > 0,
              tvCount: tvCount(roomId),
              lastSeenAt: tvLastSeen.get(roomId) ?? null,
            });
          } else {
            broadcastPresenceToLaptops(roomId);
          }
        })
        .catch((err: unknown) => console.error("[Cast] WS validate failed:", err));

      ws.on("message", (data) => {
        try {
          const raw = String(data);
          if (Buffer.byteLength(raw, "utf8") > WS_MESSAGE_BYTES_LIMIT) return;
          const parsed = JSON.parse(raw);
          if (parsed?.type === "ping") {
            sendTo(ws, { type: "pong", t: Date.now() });
            return;
          }
          if (parsed?.type === "control" && role === "laptop") {
            const out: Record<string, unknown> = { type: "control" };
            if (parsed.videoMutes && typeof parsed.videoMutes === "object") {
              const mutes: Record<string, boolean> = {};
              for (const [id, val] of Object.entries(parsed.videoMutes)) {
                if (typeof id === "string" && id.length <= 128) mutes[id] = !!val;
              }
              out.videoMutes = mutes;
            }
            if (parsed.videoPlayback && typeof parsed.videoPlayback === "object") {
              const playback: Record<string, boolean> = {};
              for (const [id, val] of Object.entries(parsed.videoPlayback)) {
                if (typeof id === "string" && id.length <= 128) playback[id] = !!val;
              }
              out.videoPlayback = playback;
            }
            const s = roomConns.get(roomId);
            if (!s) return;
            const msg = JSON.stringify(out);
            s.forEach((c) => {
              if (c.role !== "tv") return;
              if (c.ws.readyState !== WebSocket.OPEN) return;
              try { c.ws.send(msg); } catch { /* ignore */ }
            });
          }
        } catch { /* ignore */ }
      });

      ws.on("close", () => {
        clearInterval(heartbeat);
        const s = roomConns.get(roomId);
        if (!s) return;
        s.delete(conn);
        if (role === "tv") tvLastSeen.set(roomId, Date.now());
        if (s.size === 0) {
          roomConns.delete(roomId);
        } else if (role === "tv") {
          broadcastPresenceToLaptops(roomId);
        }
      });

      ws.on("error", () => { try { ws.close(); } catch { /* ignore */ } });
    },
  );

  setInterval(() => {
    purgeExpiredCodes().catch((err: unknown) =>
      console.error("[Cast] purgeExpiredCodes failed:", err),
    );
  }, 30_000).unref();

  // Schedule tick once per minute.
  setInterval(() => {
    runSchedulerTick().catch((err: unknown) =>
      console.error("[Cast scheduler] tick failed:", err),
    );
  }, SCHEDULER_TICK_MS).unref();
}
