import type { MacroContext } from "./types.ts";

export interface CalendarEvent {
  at: number;
  title: string;
  source: "BLS" | "BEA" | "FOMC";
}

const BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const BEA_URL = "https://apps.bea.gov/API/signup/release_dates.json";
const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const OFFICIAL_SOURCE = "official-us-macro-calendar-v1";
const REFRESH_INTERVAL_MS = 15 * 60_000;
const MAX_SOURCE_AGE_MS = 60 * 24 * 60 * 60_000;
const LOOKAHEAD_MS = 120 * 24 * 60 * 60_000;
const EVENT_BLOCK_MS = 15 * 60_000;

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
  if (/^\d{8}$/.test(raw)) return null; // All-day event; no release time to protect.
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
          const important = /consumer price index|\bCPI\b|producer price index|\bPPI\b|employment situation|nonfarm payroll|payroll employment/i.test(title);
          if (important) {
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

  if (events.length === 0) throw new Error("BLS feed contains no timed CPI, PPI or Employment Situation events");
  return events;
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
  for (const event of events) unique.set(`${event.at}:${event.title}`, event);
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
  const months: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const events: CalendarEvent[] = [];

  for (let i = 0; i < headings.length; i++) {
    const year = Number(headings[i]![1]);
    if (!Number.isFinite(year)) continue;
    const start = headings[i]!.index! + headings[i]![0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : text.length;
    const section = text.slice(start, end);
    const pattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\b/gi;
    for (const match of section.matchAll(pattern)) {
      const month = months[match[1]!.toLowerCase()];
      const statementDay = Number(match[3]);
      // The FOMC statement is normally released at 2:00 PM Eastern; the press
      // conference is normally scheduled for 2:30 PM Eastern. The source page
      // supplies meeting dates, while these standard release times are assumptions.
      const statement = localTimeToUtc(year, month, statementDay, 14, 0, 0, "America/New_York");
      const pressConference = localTimeToUtc(year, month, statementDay, 14, 30, 0, "America/New_York");
      if (statement !== null) events.push({ at: statement, title: "FOMC policy statement (scheduled-time assumption)", source: "FOMC" });
      if (pressConference !== null) events.push({ at: pressConference, title: "FOMC press conference (scheduled-time assumption)", source: "FOMC" });
    }
  }

  if (!events.some((event) => event.at > now && event.at <= now + 240 * 24 * 60 * 60_000)) {
    throw new Error("Federal Reserve calendar has no upcoming FOMC meeting in the coverage window");
  }
  return events;
}

export function highImpactEventWithinBlock(events: CalendarEvent[], now: number, blockMinutes = 15): CalendarEvent | null {
  const window = blockMinutes * 60_000;
  return events
    .filter((event) => Math.abs(event.at - now) <= window)
    .sort((a, b) => Math.abs(a.at - now) - Math.abs(b.at - now))[0] ?? null;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept, "cache-control": "no-cache" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Calendar fetch failed (${response.status}): ${url}`);
  return response.text();
}

export async function syncOfficialMacroCalendar(db: D1Database, current: MacroContext | undefined, now = Date.now()): Promise<boolean> {
  if (current?.source === OFFICIAL_SOURCE && current.asOf && now - current.asOf < REFRESH_INTERVAL_MS) return false;

  const [blsRaw, beaRaw, fomcRaw] = await Promise.all([
    fetchText(BLS_URL, "text/calendar"),
    fetchText(BEA_URL, "application/json"),
    fetchText(FOMC_URL, "text/html"),
  ]);

  const events = [
    ...parseBlsIcs(blsRaw),
    ...parseBeaJson(beaRaw, now),
    ...parseFomcHtml(fomcRaw, now),
  ];
  const futureBls = events.filter((event) => event.source === "BLS" && event.at > now && event.at <= now + LOOKAHEAD_MS);
  if (futureBls.length === 0) throw new Error("BLS feed has no upcoming high-impact release in the coverage window");

  const active = highImpactEventWithinBlock(events, now, 15);
  const future = events
    .filter((event) => event.at > now)
    .sort((a, b) => a.at - b.at)[0];
  const note = active
    ? `محدوده توقف خبر: ${active.title}؛ منبع: ${active.source}`
    : future
      ? `رویداد مهم بعدی: ${future.title} در ${new Date(future.at).toISOString()}؛ تقویم‌های رسمی BLS، BEA و Federal Reserve بررسی شده‌اند.`
      : "تقویم‌های رسمی BLS، BEA و Federal Reserve بررسی شده‌اند؛ رویداد زمان‌دار بعدی پیدا نشد.";

  const source = OFFICIAL_SOURCE;
  const coverageMinutes = 7 * 24 * 60;
  const highImpactEventWithinMinutes = active ? 0 : null;
  await db.prepare(
    `INSERT INTO macro_context (id, as_of, source, calendar_coverage_minutes, high_impact_event_within_minutes, dxy_trend, us10y_trend, note)
     VALUES (1, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       as_of=excluded.as_of,
       source=excluded.source,
       calendar_coverage_minutes=excluded.calendar_coverage_minutes,
       high_impact_event_within_minutes=excluded.high_impact_event_within_minutes,
       dxy_trend=NULL,
       us10y_trend=NULL,
       note=excluded.note`
  ).bind(now, source, coverageMinutes, highImpactEventWithinMinutes, note).run();

  return true;
}
