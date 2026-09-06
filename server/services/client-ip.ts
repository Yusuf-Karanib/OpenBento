import type { Request } from "express";

/**
 * Return the address Express resolved after applying the app's trust-proxy
 * policy. Never parse X-Forwarded-For here: clients can forge its first value.
 */
export function getClientIp(req: Request): string {
  const resolved = typeof req.ip === "string" ? req.ip.trim() : "";
  const direct = req.socket.remoteAddress?.trim() ?? "";
  return (resolved || direct || "unknown").slice(0, 64);
}
