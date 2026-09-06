// Supabase Bearer-token middleware shared by /api/dashboard and /api/cast/*.
// Verifies access tokens via Supabase /auth/v1/user with bounded caches,
// per-client throttling, and one shared request per token.
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getClientIp } from "./client-ip";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limit";
import { LruTtlCache } from "./lruCache";

interface SupabaseUser {
  id: string;
  email: string;
}

type VerificationResult =
  | { status: "authenticated"; user: SupabaseUser }
  | { status: "invalid" }
  | { status: "unavailable" };

const ACCESS_TOKEN_MAX_BYTES = 8 * 1024;
const AUTH_LOOKUP_TIMEOUT_MS = 5_000;
const AUTH_LOOKUP_RATE_WINDOW_MS = 60_000;
const AUTH_LOOKUP_RATE_MAX = 30;
const MAX_INFLIGHT_VERIFICATIONS = 1_000;

const supabaseUserCache = new LruTtlCache<SupabaseUser>({
  max: 500,
  ttlMs: 5 * 60 * 1000,
});
const invalidTokenCache = new LruTtlCache<true>({
  max: 1_000,
  ttlMs: 30_000,
});
const authLookupRateLimit = new FixedWindowRateLimiter({
  windowMs: AUTH_LOOKUP_RATE_WINDOW_MS,
  maxAttempts: AUTH_LOOKUP_RATE_MAX,
});
const inflightVerifications = new Map<string, Promise<VerificationResult>>();

function decodeJwtObject(segment: string): Record<string, unknown> | null {
  // A base64url segment with this remainder cannot be valid, even with padding.
  if (!segment || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }

  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Cheap shape check only. Supabase remains the authority that verifies the JWT. */
export function isPlausibleSupabaseAccessToken(token: string): boolean {
  if (!token || Buffer.byteLength(token, "utf8") > ACCESS_TOKEN_MAX_BYTES) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[2].length < 16 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
    return false;
  }

  const header = decodeJwtObject(parts[0]);
  const payload = decodeJwtObject(parts[1]);
  return Boolean(
    header
      && typeof header.alg === "string"
      && header.alg.length > 0
      && header.alg.toLowerCase() !== "none"
      && payload
      && typeof payload.sub === "string"
      && payload.sub.length > 0,
  );
}

function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function verifyWithSupabase(
  token: string,
  supabaseUrl: string,
  anonKey: string,
): Promise<VerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
      signal: controller.signal,
    });

    if (response.ok) {
      const user = await response.json();
      if (user && typeof user.id === "string" && user.id.length > 0) {
        return {
          status: "authenticated",
          user: {
            id: user.id,
            email: typeof user.email === "string" ? user.email : "",
          },
        };
      }
      return { status: "invalid" };
    }

    // Cache definite token rejections, but let temporary upstream failures retry.
    if (
      response.status >= 400
      && response.status < 500
      && response.status !== 408
      && response.status !== 429
    ) {
      return { status: "invalid" };
    }
  } catch {
    /* leave userId unset while Supabase is unavailable */
  } finally {
    clearTimeout(timeout);
  }

  return { status: "unavailable" };
}

function attachUser(req: Request, user: SupabaseUser): void {
  (req as any).userId = user.id;
  (req as any).user = { id: user.id, email: user.email };
}

export async function attachSupabaseUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return next();
  const token = match[1].trim();
  if (!isPlausibleSupabaseAccessToken(token)) return next();

  // Hash cache keys so raw access tokens are not retained as map keys.
  const cacheKey = tokenCacheKey(token);

  const cached = supabaseUserCache.get(cacheKey);
  if (cached) {
    attachUser(req, cached);
    return next();
  }
  if (invalidTokenCache.get(cacheKey)) return next();

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey) return next();

  let verification = inflightVerifications.get(cacheKey);
  if (!verification) {
    if (!authLookupRateLimit.allow(getClientIp(req))) return next();
    if (inflightVerifications.size >= MAX_INFLIGHT_VERIFICATIONS) return next();

    verification = verifyWithSupabase(token, supabaseUrl, anonKey);
    inflightVerifications.set(cacheKey, verification);
  }

  let result: VerificationResult;
  try {
    result = await verification;
  } finally {
    if (inflightVerifications.get(cacheKey) === verification) {
      inflightVerifications.delete(cacheKey);
    }
  }

  if (result.status === "authenticated") {
    supabaseUserCache.set(cacheKey, result.user);
    attachUser(req, result.user);
  } else if (result.status === "invalid") {
    invalidTokenCache.set(cacheKey, true);
  }

  next();
}

export function getUserId(req: Request): string | null {
  return (req as any).userId || (req as any).user?.id || null;
}
