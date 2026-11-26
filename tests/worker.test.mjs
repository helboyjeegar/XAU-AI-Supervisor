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


test("authenticated Telegram /test webhook sends a real-shaped Bot API reply", async () => {
  const secret = "unit-test-webhook-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const token = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": token },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "/test" } }),
    }), { TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_CHAT_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot-token" });
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /api\.telegram\.org\/bottest-bot-token\/sendMessage$/);
    assert.equal(String(sent[0].body.chat_id), "123");
    assert.match(sent[0].body.text, /آزمایش تلگرام/);
    assert.match(sent[0].body.text, /هیچ تحلیلی یا سفارشی اجرا نشده/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Telegram webhook ignores messages from chats other than the configured chat", async () => {
  const secret = "unit-test-webhook-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const token = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
  try {
    const response = await worker.fetch(new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": token },
      body: JSON.stringify({ message: { chat: { id: 999 }, text: "/test" } }),
    }), { TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_CHAT_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot-token" });
    assert.equal(response.status, 200);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("Telegram webhook silently ignores plain-text status reports", async () => {
  const secret = "unit-test-webhook-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const token = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
  try {
    const response = await worker.fetch(new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": token },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "گزارش فنی نسخه جدید منتشر شد" } }),
    }), { TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_CHAT_ID: "123", TELEGRAM_BOT_TOKEN: "test-bot-token" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ignored: true });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
