import test from "node:test";
import assert from "node:assert/strict";
import { parseAiReview } from "../src/ai-challenger.ts";

test("AI review parser accepts only the veto schema", () => {
  assert.deepEqual(parseAiReview({ response: '{"veto":true,"reasons":["Contradictory trend"]}' }), {
    veto: true,
    reasons: ["Contradictory trend"],
  });
});

test("AI review parser rejects malformed or approval-shaped output", () => {
  assert.equal(parseAiReview({ response: "not json" }), null);
  assert.equal(parseAiReview({ response: '{"approved":true}' }), null);
});
