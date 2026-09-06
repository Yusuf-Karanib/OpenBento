import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request } from "express";
import { getClientIp } from "../../server/services/client-ip";

test("client address comes from Express instead of a forgeable raw header", () => {
  const req = {
    ip: "203.0.113.8",
    headers: { "x-forwarded-for": "198.51.100.99" },
    socket: { remoteAddress: "10.0.0.4" },
  } as unknown as Request;

  assert.equal(getClientIp(req), "203.0.113.8");
});

test("server trusts one proxy only on a published Replit app", () => {
  const index = readFileSync("server/index.ts", "utf8");
  const routes = readFileSync("server/routes.ts", "utf8");
  const cast = readFileSync("server/services/cast-hub.ts", "utf8");

  assert.match(index, /REPLIT_DEPLOYMENT === "1" \? 1 : false/);
  assert.doesNotMatch(routes, /x-forwarded-for/i);
  assert.doesNotMatch(cast, /x-forwarded-for/i);
});
