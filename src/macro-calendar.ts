import type { MacroContext } from "./types.ts";

export interface CalendarEvent {
  at: number;
  title: string;
  source: "BLS" | "BEA" | "FOMC" | "OTHER";
}

const BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const BEA_URL = "https://apps.bea.gov/API/signup/release_dates.json";
const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const OFFICIAL_SOURCE = "official-us-macro-calendar-v1";
const XOOMAR_SOURCE = "xoomar-us-calendar-v1";
const XOOMAR_URL = "https://xoomar.com/api/markets/calendar";
const REFRESH_INTERVAL_MS = 15 * 60_000;
const MAX_SOURCE_AGE_MS = 60 * 24 * 60 * 60_000;
const LOOKAHEAD_MS = 120 * 24 * 60 * 60_000;
const MAX_BLS_SCHEDULE_AGE_MS = 45 * 24 * 60 * 60_000;

const MONTH_NUMBERS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const BLS_PFEI_PATTERN =
  /consumer price index|producer price index|employment situation|employment cost index|productivity and costs|real earnings|u\.s\. (?:import and export|export and import) price indexes/i;

function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number | null {
  try {
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(localAsUtc));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const representedAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const result = localAsUtc - (representedAsUtc - localAsUtc);
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function parseIcsDate(property: string, value: string): number | null {
  const raw = value.trim();
  if (/^\d{8}$/.test(raw)) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!match) return null;

  const [, y, mo, d, h, mi, sec = "0", z] = match;
  const parts = [y, mo, d, h, mi, sec].map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (z) return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);

  const tzid = property.match(/(?:^|;)TZID=([^;:]+)/i)?.[1] ?? "America/New_York";
  return localTimeToUtc(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], tzid);
}

export function parseBlsIcs(ics: string): CalendarEvent[] {
  if (!ics.includes("BEGIN:VCALENDAR") || !ics.includes("BEGIN:VEVENT")) {
    throw new Error("BLS calendar is not a valid iCalendar feed");
  }
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: CalendarEvent[] = [];
  let block: string[] | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      block = [];
      continue;
    }
    if (line === "END:VEVENT" && block) {
      const summaryLine = block.find((item) => item.toUpperCase().startsWith("SUMMARY"));
      const startLine = block.find((item) => item.toUpperCase().startsWith("DTSTART"));
      if (summaryLine && startLine) {
        const colon = summaryLine.indexOf(":");
        const startColon = startLine.indexOf(":");
        if (colon > 0 && startColon > 0) {
          const title = decodeIcsText(summaryLine.slice(colon + 1));
          if (BLS_PFEI_PATTERN.test(title)) {
            const at = parseIcsDate(startLine.slice(0, startColon), startLine.slice(startColon + 1));
            if (at !== null) events.push({ at, title, source: "BLS" });
          }
        }
      }
      block = null;
      continue;
    }
    if (block) block.push(line);
  }

  if (events.length === 0) throw new Error("BLS feed contains no timed Principal Federal Economic Indicator events");
  return events;
}

function cleanHtmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:tr|p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "");
}

export function parseBlsScheduleHtml(html: string, now = Date.now()): CalendarEvent[] {
  if (!/Bureau of Labor Statistics|Schedule of Releases|Schedule of Selected Releases/i.test(html)) {
    throw new Error("BLS annual schedule page is not recognized");
  }

  const text = cleanHtmlText(html);
  const lastModifiedDates = [...text.matchAll(/Last Modified Date:\s*([A-Za-z]+\s+\d{1,2},\s+20\d{2})/gi)]
    .map((match) => Date.parse(match[1]!));
  const latestModified = lastModifiedDates.filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (
    !latestModified ||
    latestModified > now + 24 * 60 * 60_000 ||
    now - latestModified > MAX_BLS_SCHEDULE_AGE_MS
  ) {
    throw new Error("BLS annual schedule has no recent Last Modified Date (maximum age 45 days)");
  }

  const rowPattern =
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(20\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+(.+)$/i;
  const events: CalendarEvent[] = [];

  for (const line of text.split("\n")) {
    const match = line.trim().match(rowPattern);
    if (!match) continue;

    const month = MONTH_NUMBERS[match[1]!.toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    const meridiem = match[6]!.toUpperCase();
    const title = match[7]!.trim().replace(/\s+/g, " ");

    if (!month || !Number.isInteger(day) || !Number.isInteger(year) || !BLS_PFEI_PATTERN.test(title)) continue;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;

    const at = localTimeToUtc(year, month, day, hour, minute, 0, "America/New_York");
    if (at !== null) events.push({ at, title, source: "BLS" });
  }

  if (events.length === 0) {
    throw new Error("BLS annual schedule contains no timed Principal Federal Economic Indicator releases");
  }
  return events;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const host = new URL(url).hostname;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept,
        "cache-control": "no-cache",
        "user-agent": "XAU-AI-Supervisor/0.3 (+https://github.com/helboyjeegar/XAU-AI-Supervisor)",
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.name + ": " + error.message : String(error);
    throw new Error("Calendar network request failed for " + host + ": " + detail);
  }
  if (!response.ok) {
    throw new Error(
      "Calendar HTTP " + response.status + " from " + host +
      "; content-type=" + (response.headers.get("content-type") ?? "unknown"),
    );
  }
  return response.text();
}

async function fetchBlsEvents(now: number): Promise<CalendarEvent[]> {
  const year = new Date(now).getUTCFullYear();
  const failures: string[] = [];

  try {
    const ics = await fetchText(BLS_URL, "text/calendar");
    return parseBlsIcs(ics);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const years = [year, year + 1];
  const pages = await Promise.all(years.map(async (calendarYear) => {
    const url = "https://www.bls.gov/schedule/" + calendarYear + "/home.htm";
    try {
      const html = await fetchText(url, "text/html");
      return parseBlsScheduleHtml(html, now);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  }));

  if (pages.some((events) => events.length === 0)) {
    throw new Error(
      "Both current-year and next-year official BLS schedules are required for complete forward coverage: " +
      failures.join(" | "),
    );
  }
  return pages.flat();
}

export function parseBeaJson(raw: string, now = Date.now()): CalendarEvent[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BEA release calendar is not valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("BEA release calendar has an invalid shape");
  const record = parsed as Record<string, unknown>;
  const updatedAt = typeof record.file_last_updated === "string" ? Date.parse(record.file_last_updated) : NaN;
  if (!Number.isFinite(updatedAt) || updatedAt > now + 5 * 60_000 || now - updatedAt > MAX_SOURCE_AGE_MS) {
    throw new Error("BEA release calendar timestamp is missing or too old");
  }

  const events: CalendarEvent[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (!/gross domestic product|personal income and outlays/i.test(name)) continue;
    if (typeof value !== "object" || value === null || !("release_dates" in value)) continue;
    const dates = (value as { release_dates?: unknown }).release_dates;
    if (!Array.isArray(dates)) continue;
    for (const date of dates) {
      if (typeof date !== "string") continue;
      const at = Date.parse(date);
      if (Number.isFinite(at)) events.push({ at, title: name, source: "BEA" });
    }
  }

  const unique = new Map<string, CalendarEvent>();
  for (const event of events) unique.set(String(event.at) + ":" + event.title, event);
  if (![...unique.values()].some((event) => event.title.toLowerCase().includes("gross domestic product") && event.at > now && event.at <= now + LOOKAHEAD_MS)) {
    throw new Error("BEA feed has no upcoming GDP release in the coverage window");
  }
  if (![...unique.values()].some((event) => event.title.toLowerCase().includes("personal income and outlays") && event.at > now && event.at <= now + LOOKAHEAD_MS)) {
    throw new Error("BEA feed has no upcoming Personal Income and Outlays release in the coverage window");
  }
  return [...unique.values()];
}

export function parseFomcHtml(html: string, now = Date.now()): CalendarEvent[] {
  if (!/FOMC Meetings/i.test(html)) throw new Error("Federal Reserve calendar page is not recognized");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");

  const headings = [...text.matchAll(/(20\d{2})\s+FOMC Meetings/gi)];
  const events: CalendarEvent[] = [];

  for (let i = 0; i < headings.length; i++) {
    const year = Number(headings[i]![1]);
    if (!Number.isFinite(year)) continue;
    const start = headings[i]!.index! + headings[i]![0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : text.length;
    const section = text.slice(start, end);
    const pattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\b/gi;

    for (const match of section.matchAll(pattern)) {
      const month = MONTH_NUMBERS[match[1]!.toLowerCase()];
      const statementDay = Number(match[3]);
      const statement = localTimeToUtc(year, month, statementDay, 14, 0, 0, "America/New_York");
      const pressConference = localTimeToUtc(year, month, statementDay, 14, 30, 0, "America/New_York");
      if (statement !== null) {
        events.push({ at: statement, title: "FOMC policy statement (scheduled-time assumption)", source: "FOMC" });
      }
      if (pressConference !== null) {
        events.push({ at: pressConference, title: "FOMC press conference (scheduled-time assumption)", source: "FOMC" });
      }
    }
  }

  if (!events.some((event) => event.at > now && event.at <= now + 240 * 24 * 60 * 60_000)) {
    throw new Error("Federal Reserve calendar has no upcoming FOMC meeting in the coverage window");
  }
  return events;
}

export interface XoomarCalendarResult {
  events: CalendarEvent[];
  updatedAt: number;
  attribution: string;
}

// XOOMAR documents that agency schedule changes can take up to one week to appear.
// Keep one extra day for weekends/processing, but never accept a calendar older than 8 days.
export function parseXoomarCalendar(raw: string, now = Date.now()): XoomarCalendarResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("XOOMAR calendar response is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("XOOMAR calendar response has an invalid shape");
  }

  const envelope = parsed as Record<string, unknown>;
  const updatedAt = typeof envelope.updatedAt === "string" ? Date.parse(envelope.updatedAt) : NaN;
  if (
    !Number.isFinite(updatedAt) ||
    updatedAt > now + 5 * 60_000 ||
    now - updatedAt > 8 * 24 * 60 * 60_000
  ) {
    throw new Error("XOOMAR calendar updatedAt is missing, future-dated or older than 8 days");
  }

  const meta = typeof envelope.meta === "object" && envelope.meta !== null
    ? envelope.meta as Record<string, unknown>
    : {};
  const attribution =
    typeof meta.sourceAttribution === "string" ? meta.sourceAttribution.trim() : "";
  if (!attribution) {
    throw new Error("XOOMAR calendar is missing its required source attribution");
  }

  if (!Array.isArray(envelope.data)) {
    throw new Error("XOOMAR calendar data field is not an array");
  }

  const events: CalendarEvent[] = [];
  for (const item of envelope.data) {
    if (typeof item !== "object" || item === null) continue;
    const event = item as Record<string, unknown>;
    if (typeof event.importance !== "string" || event.importance.toLowerCase() !== "high") continue;
    if (typeof event.eventName !== "string" || typeof event.source !== "string") continue;
    if (typeof event.scheduledAt !== "string") continue;

    const at = Date.parse(event.scheduledAt);
    if (!Number.isFinite(at) || at < now - 15 * 60_000 || at > now + LOOKAHEAD_MS) continue;

    const sourceName = event.source.toLowerCase();
    const source: CalendarEvent["source"] =
      sourceName === "bls" ? "BLS" :
      sourceName === "bea" ? "BEA" :
      sourceName === "fed" ? "FOMC" : "OTHER";

    events.push({ at, title: event.eventName, source });
  }

  const upcoming = events.filter((event) => event.at > now && event.at <= now + LOOKAHEAD_MS);
  const sources = new Set(upcoming.map((event) => event.source));
  if (upcoming.length === 0) {
    throw new Error("XOOMAR calendar has no upcoming high-importance events in the 120-day window");
  }
  if (!sources.has("BLS") || !sources.has("BEA") || !sources.has("FOMC")) {
    throw new Error("XOOMAR calendar does not cover upcoming BLS, BEA and FOMC events");
  }

  return { events, updatedAt, attribution };
}

async function fetchXoomarCalendarEvents(now: number): Promise<XoomarCalendarResult> {
  const from = new Date(now).toISOString().slice(0, 10);
  const to = new Date(now + LOOKAHEAD_MS).toISOString().slice(0, 10);
  const url = XOOMAR_URL + "?from=" + from + "&to=" + to + "&importance=high";
  const raw = await fetchText(url, "application/json");
  return parseXoomarCalendar(raw, now);
}

export function highImpactEventWithinBlock(events: CalendarEvent[], now: number, blockMinutes = 15): CalendarEvent | null {
  const window = blockMinutes * 60_000;
  return events
    .filter((event) => Math.abs(event.at - now) <= window)
    .sort((a, b) => Math.abs(a.at - now) - Math.abs(b.at - now))[0] ?? null;
}

export async function syncOfficialMacroCalendar(
  db: D1Database,
  current: MacroContext | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (
    (current?.source === OFFICIAL_SOURCE || current?.source === XOOMAR_SOURCE) &&
    current.asOf &&
    now - current.asOf < REFRESH_INTERVAL_MS
  ) {
    return false;
  }

  let events: CalendarEvent[];
  let source: string;
  let sourceNote: string;

  try {
    const [blsEvents, beaRaw, fomcRaw] = await Promise.all([
      fetchBlsEvents(now),
      fetchText(BEA_URL, "application/json"),
      fetchText(FOMC_URL, "text/html"),
    ]);
    events = [
      ...blsEvents,
      ...parseBeaJson(beaRaw, now),
      ...parseFomcHtml(fomcRaw, now),
    ];
    const futureBls = events.filter(
      (event) => event.source === "BLS" && event.at > now && event.at <= now + LOOKAHEAD_MS,
    );
    if (futureBls.length === 0) {
      throw new Error("Official BLS calendar has no upcoming high-impact release in the coverage window");
    }
    source = OFFICIAL_SOURCE;
    sourceNote = "تقویم‌های رسمی BLS، BEA و Federal Reserve دریافت و اعتبارسنجی شدند.";
  } catch (officialError) {
    const officialDetail = officialError instanceof Error ? officialError.message : String(officialError);
    try {
      const fallback = await fetchXoomarCalendarEvents(now);
      events = fallback.events;
      source = XOOMAR_SOURCE;
      sourceNote =
        "تقویم جایگزین XOOMAR با رویدادهای زمان‌بندی‌شده از منابع BLS، BEA و Federal Reserve؛ " +
        "به‌روزرسانی منبع: " + new Date(fallback.updatedAt).toISOString() +
        ". Data: XOOMAR — https://xoomar.com/markets/api/calendar. " +
        "محدودیت: این منبع تجمیعی ممکن است تغییر برنامه سازمان‌ها را با تأخیر منعکس کند.";
    } catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        "Official macro calendars failed: " + officialDetail +
        " | XOOMAR fallback failed: " + fallbackDetail,
      );
    }
  }

  const active = highImpactEventWithinBlock(events, now, 15);
  const future = events
    .filter((event) => event.at > now)
    .sort((a, b) => a.at - b.at)[0];
  const note = active
    ? "محدوده توقف خبر: " + active.title + "؛ منبع: " + active.source + ". " +
      sourceNote + " جهت DXY و بازده اوراق هنوز متصل نیست."
    : future
      ? "رویداد مهم بعدی: " + future.title + " در " + new Date(future.at).toISOString() +
        ". " + sourceNote + " جهت DXY و بازده اوراق هنوز متصل نیست."
      : sourceNote + " جهت DXY و بازده اوراق هنوز متصل نیست.";

  const coverageMinutes = 120 * 24 * 60;
  const highImpactEventWithinMinutes = active ? 0 : null;
  await db.prepare(
    "INSERT INTO macro_context (id, as_of, source, calendar_coverage_minutes, high_impact_event_within_minutes, dxy_trend, us10y_trend, note) " +
    "VALUES (1, ?, ?, ?, ?, NULL, NULL, ?) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "as_of=excluded.as_of, source=excluded.source, " +
    "calendar_coverage_minutes=excluded.calendar_coverage_minutes, " +
    "high_impact_event_within_minutes=excluded.high_impact_event_within_minutes, " +
    "dxy_trend=NULL, us10y_trend=NULL, note=excluded.note",
  ).bind(now, source, coverageMinutes, highImpactEventWithinMinutes, note).run();

  return true;
}
