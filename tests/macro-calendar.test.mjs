import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBlsIcs,
  parseBeaJson,
  parseFomcHtml,
  highImpactEventWithinBlock,
} from "../src/macro-calendar.ts";

const now = Date.parse("2026-11-25T15:00:00.000Z");

test("BLS iCalendar parses Eastern release times into UTC", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261210T083000",
    "SUMMARY:Consumer Price Index for November 2026",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261215T083000",
    "SUMMARY:Producer Price Index for November 2026",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseBlsIcs(ics);
  assert.equal(events.length, 2);
  assert.equal(events[0].at, Date.parse("2026-12-10T13:30:00.000Z"));
  assert.equal(events[1].source, "BLS");
});

test("BEA release JSON accepts fresh GDP and PCE schedule entries", () => {
  const payload = {
    "Gross Domestic Product": {
      release_dates: ["2026-12-23T13:30:00+00:00"],
    },
    "Personal Income and Outlays": {
      release_dates: ["2026-12-23T13:30:00+00:00"],
    },
    file_last_updated: "2026-10-22T12:48:27.656675",
  };
  const events = parseBeaJson(JSON.stringify(payload), now);
  assert.equal(events.length, 2);
  assert.equal(events[0].at, Date.parse("2026-12-23T13:30:00.000Z"));
});

test("Federal Reserve page parser extracts statement and press-conference windows", () => {
  const html = [
    "<h3>2026 FOMC Meetings</h3>",
    "<p>December</p><p>8-9*</p>",
    "<h3>2025 FOMC Meetings</h3>",
    "<p>December</p><p>9-10*</p>",
    "<h3>2027 FOMC Meetings</h3>",
    "<p>January</p><p>26-27</p>",
  ].join("");
  const events = parseFomcHtml(html, now);
  assert.ok(events.some((event) => event.at === Date.parse("2026-12-09T19:00:00.000Z")));
  assert.ok(events.some((event) => event.at === Date.parse("2026-12-09T19:30:00.000Z")));
  assert.ok(events.some((event) => event.at === Date.parse("2027-01-27T19:00:00.000Z")));
});

test("high-impact calendar blocks within plus or minus fifteen minutes", () => {
  const event = { at: now + 10 * 60_000, title: "CPI", source: "BLS" };
  assert.equal(highImpactEventWithinBlock([event], now)?.title, "CPI");
  assert.equal(highImpactEventWithinBlock([event], now + 26 * 60_000), null);
  assert.equal(highImpactEventWithinBlock([event], now + 20 * 60_000)?.title, "CPI");
});
