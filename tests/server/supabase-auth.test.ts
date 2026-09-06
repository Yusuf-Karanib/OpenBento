import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import {
  attachSupabaseUser,
  isPlausibleSupabaseAccessToken,
} from "../../server/services/supabaseAuth";

function makeJwt(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = Buffer.alloc(32, subject.charCodeAt(0) || 1).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: subject })}.${signature}`;
}

function makeRequest(token: string, ip: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

async function runMiddleware(req: Request): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const next: NextFunction = (error?: unknown) => error ? reject(error) : resolve();
    void attachSupabaseUser(req, {} as Response, next);
  });
}

function setAuthEnvironment(): () => void {
  const previousUrl = process.env.VITE_SUPABASE_URL;
  const previousKey = process.env.VITE_SUPABASE_ANON_KEY;
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "test-anon-key";

  return () => {
    if (previousUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
    else process.env.VITE_SUPABASE_ANON_KEY = previousKey;
  };
}

test("access-token shape check accepts JWTs and rejects malformed or oversized values", () => {
  assert.equal(isPlausibleSupabaseAccessToken(makeJwt("valid-user")), true);
  assert.equal(isPlausibleSupabaseAccessToken("not-a-jwt"), false);
  assert.equal(isPlausibleSupabaseAccessToken("e30.e30.signature-long-enough"), false);
  assert.equal(isPlausibleSupabaseAccessToken(`${"a".repeat(8_193)}.b.c`), false);
});

test("malformed tokens never reach Supabase", async () => {
  const restoreEnvironment = setAuthEnvironment();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("fetch should not run");
  }) as typeof fetch;

  try {
    await runMiddleware(makeRequest("random-attacker-input", "198.51.100.10"));
    await runMiddleware(makeRequest("x".repeat(9_000), "198.51.100.10"));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});

test("concurrent checks for one valid token share one Supabase request", async () => {
  const restoreEnvironment = setAuthEnvironment();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    calls++;
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "shared-user", email: "user@example.com" }),
    } as Response;
  }) as typeof fetch;

  try {
    const token = makeJwt("concurrent-user");
    const first = makeRequest(token, "198.51.100.20");
    const second = makeRequest(token, "198.51.100.21");
    const firstRun = runMiddleware(first);
    const secondRun = runMiddleware(second);
    assert.equal(calls, 1);

    release();
    await Promise.all([firstRun, secondRun]);
    assert.equal((first as any).userId, "shared-user");
    assert.equal((second as any).userId, "shared-user");

    const cached = makeRequest(token, "198.51.100.22");
    await runMiddleware(cached);
    assert.equal(calls, 1);
    assert.equal((cached as any).userId, "shared-user");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});

test("a rejected token is held briefly instead of being checked repeatedly", async () => {
  const restoreEnvironment = setAuthEnvironment();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: false, status: 401 } as Response;
  }) as typeof fetch;

  try {
    const token = makeJwt("rejected-user");
    await runMiddleware(makeRequest(token, "198.51.100.30"));
    await runMiddleware(makeRequest(token, "198.51.100.30"));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});

test("one client cannot create more than 30 uncached auth checks per minute", async () => {
  const restoreEnvironment = setAuthEnvironment();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: false, status: 401 } as Response;
  }) as typeof fetch;

  try {
    for (let index = 0; index < 31; index++) {
      await runMiddleware(makeRequest(makeJwt(`limited-user-${index}`), "198.51.100.40"));
    }
    assert.equal(calls, 30);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});
