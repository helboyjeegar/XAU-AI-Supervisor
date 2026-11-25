import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBlsIcs,
  parseBlsScheduleHtml,
  parseXoomarCalendar,
  parseShowMyTradesCalendar,
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


test("BLS official annual HTML schedule parses only fresh PFEI releases as Eastern time", () => {
  const html = [
    "<h1>Schedule of Selected Releases</h1>",
    "<table>",
    "<tr><td>Friday, December 04, 2026</td><td>08:30 AM</td><td>Employment Situation for November 2026</td></tr>",
    "<tr><td>Thursday, December 10, 2026</td><td>08:30 AM</td><td>Consumer Price Index for November 2026</td></tr>",
    "<tr><td>Friday, December 11, 2026</td><td>08:30 AM</td><td>Real Earnings for November 2026</td></tr>",
    "<tr><td>Tuesday, December 15, 2026</td><td>08:30 AM</td><td>Producer Price Index for November 2026</td></tr>",
    "</table>",
    "<p>NOTE: All times on calendar are Eastern Time. Last Modified Date: November 09, 2026</p>",
  ].join("");
  const events = parseBlsScheduleHtml(html, now);
  assert.equal(events.length, 4);
  assert.equal(events[0].at, Date.parse("2026-12-04T13:30:00.000Z"));
  assert.equal(events[1].at, Date.parse("2026-12-10T13:30:00.000Z"));
  assert.ok(events.some((event) => event.title.startsWith("Real Earnings")));
  assert.ok(events.some((event) => event.title.startsWith("Producer Price Index")));
});

test("BLS annual HTML schedule rejects stale official pages", () => {
  const stale = [
    "<h1>Schedule of Releases</h1>",
    "<tr><td>Friday, December 04, 2026</td><td>08:30 AM</td><td>Employment Situation</td></tr>",
    "<p>Last Modified Date: October 01, 2026</p>",
  ].join("");
  assert.throws(() => parseBlsScheduleHtml(stale, now), /maximum age 45 days/);
});


test("XOOMAR fallback validates freshness, attribution and official source coverage", () => {
  const payload = {
    updatedAt: "2026-11-19T14:55:00.000Z",
    meta: { sourceAttribution: "Data: XOOMAR" },
    data: [
      { source: "bls", eventName: "Consumer Price Index", importance: "high", scheduledAt: "2026-12-10T13:30:00.000Z" },
      { source: "bea", eventName: "Personal Income and Outlays (PCE)", importance: "high", scheduledAt: "2026-12-23T13:30:00.000Z" },
      { source: "fed", eventName: "FOMC Rate Decision", importance: "high", scheduledAt: "2026-12-09T19:00:00.000Z" },
      { source: "bls", eventName: "Low importance test event", importance: "low", scheduledAt: "2026-12-05T13:30:00.000Z" }
    ]
  };
  const result = parseXoomarCalendar(JSON.stringify(payload), now);
  assert.equal(result.events.length, 3);
  assert.equal(result.attribution, "Data: XOOMAR");
  assert.equal(result.events[0].source, "BLS");
  assert.equal(result.events[1].source, "BEA");
  assert.equal(result.events[2].source, "FOMC");
});

test("XOOMAR fallback rejects stale data and missing attribution", () => {
  const base = {
    meta: { sourceAttribution: "Data: XOOMAR" },
    data: [
      { source: "bls", eventName: "CPI", importance: "high", scheduledAt: "2026-12-10T13:30:00.000Z" },
      { source: "bea", eventName: "PCE", importance: "high", scheduledAt: "2026-12-23T13:30:00.000Z" },
      { source: "fed", eventName: "FOMC Rate Decision", importance: "high", scheduledAt: "2026-12-09T19:00:00.000Z" }
    ]
  };
  assert.throws(
    () => parseXoomarCalendar(JSON.stringify({ ...base, updatedAt: "2026-11-15T14:55:00.000Z" }), now),
    /older than 8 days/
  );
  assert.throws(
    () => parseXoomarCalendar(JSON.stringify({ ...base, updatedAt: "2026-11-25T14:55:00.000Z", meta: {} }), now),
    /missing its required source attribution/
  );
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
