import test from "node:test";
import assert from "node:assert/strict";
import { parseRiskCommand } from "../src/telegram.ts";

test("parses a manual risk snapshot", () => {
  assert.deepEqual(parseRiskCommand("/risk 10000 9950"), {
    dayStartEquity: 10000,
    currentEquity: 9950,
  });
});

test("parses grouped and bot-addressed amounts", () => {
  assert.deepEqual(parseRiskCommand("/risk@XAU_AI_Supervisor_Test_bot 10,000 9,950.25"), {
    dayStartEquity: 10000,
    currentEquity: 9950.25,
  });
});

test("rejects malformed, missing, zero and excessive values", () => {
  for (const value of [
    "/risk",
    "/risk 10000",
    "/risk 10000 -5",
    "/risk 0 9000",
    "/risk 10000 9e3",
    "/risk 10000 9000 extra",
    "/status 10000 9000",
    "/risk 10000.12345 9000",
    "/risk 1000000001 9000",
  ]) assert.equal(parseRiskCommand(value), null, value);
});
