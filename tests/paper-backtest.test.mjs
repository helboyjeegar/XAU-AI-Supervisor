import test from "node:test";
import assert from "node:assert/strict";
import { runPaperBacktestMonth } from "../src/paper-backtest.ts";

function emptyDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() { return { results: [] }; },
        async run() { statements.push({ sql, values: this.values }); return { success: true }; },
      };
      return statement;
    },
  };
}

test("monthly backtest records a zero-trade result when the month has no candles", async () => {
  const db = emptyDb();
  const now = Date.parse("2026-12-15T12:00:00Z");
  const result = await runPaperBacktestMonth(db, "2026-11", now);
  assert.equal(result.month, "2026-11");
  assert.equal(result.complete, true);
  assert.equal(result.trades, 0);
  assert.equal(result.netPnl, 0);
  assert.equal(result.candles, 0);
  assert.equal(db.statements.length, 1);
  assert.match(db.statements[0].sql, /paper_backtest_monthly/);
});

test("monthly backtest marks the current month as incomplete", async () => {
  const db = emptyDb();
  const now = Date.parse("2026-11-26T18:00:00Z");
  const result = await runPaperBacktestMonth(db, "2026-11", now);
  assert.equal(result.complete, false);
});

test("monthly backtest rejects invalid month values", async () => {
  await assert.rejects(() => runPaperBacktestMonth(emptyDb(), "2026-13"));
  await assert.rejects(() => runPaperBacktestMonth(emptyDb(), "November"));
});
