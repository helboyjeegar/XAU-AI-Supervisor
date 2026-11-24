import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

test("health endpoint reports fail-safe non-execution mode", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {});
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.executionEnabled, false);
  assert.equal(payload.databaseConfigured, false);
});

test("administrative endpoints reject requests without an ingest secret", async () => {
  const response = await worker.fetch(new Request("https://example.test/analysis/run", { method: "POST" }), {});
  assert.equal(response.status, 401);
});

test("Telegram webhook rejects requests without Telegram secret-token header", async () => {
  const response = await worker.fetch(new Request("https://example.test/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 123 }, text: "/status" } }),
  }), { TELEGRAM_CHAT_ID: "123" });
  assert.equal(response.status, 401);
});
