import test from "node:test";
import assert from "node:assert/strict";
import { reserveAiRunBudget } from "../src/storage.ts";

function mockDb(returned) {
  const calls = [];
  return { calls, prepare(sql) { return { bind(...values) { return { async first() { calls.push({ sql, values }); return returned; } }; } }; } };
}

test("reserves one daily AI run with an atomic cap predicate", async () => {
  const db = mockDb({ run_count: 1 });
  assert.equal(await reserveAiRunBudget(db, "2026-11-26", 8, 1234), true);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /ON CONFLICT\(day_key\) DO UPDATE/);
  assert.match(db.calls[0].sql, /WHERE ai_daily_budget\.run_count < \?/);
  assert.deepEqual(db.calls[0].values, ["2026-11-26", 1234, 8]);
});

test("denies reservations after the configured daily cap", async () => {
  const db = mockDb(null);
  assert.equal(await reserveAiRunBudget(db, "2026-11-26", 8, 1234), false);
});

test("rejects invalid day keys and non-positive budgets without touching D1", async () => {
  const db = mockDb({ run_count: 1 });
  assert.equal(await reserveAiRunBudget(db, "today", 8, 1234), false);
  assert.equal(await reserveAiRunBudget(db, "2026-11-26", 0, 1234), false);
  assert.equal(db.calls.length, 0);
});
