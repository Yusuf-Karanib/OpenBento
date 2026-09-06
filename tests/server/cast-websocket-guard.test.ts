import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Cast rejects oversized WebSocket messages before buffering them", () => {
  const source = readFileSync("server/services/cast-hub.ts", "utf8");

  assert.match(source, /maxPayload:\s*WS_MESSAGE_BYTES_LIMIT/);
  assert.match(source, /Buffer\.byteLength\(raw, "utf8"\) > WS_MESSAGE_BYTES_LIMIT/);
});
