/**
 * XAUUSD session gate.
 *
 * London: 08:00-17:00 Europe/London, Monday-Friday.
 * New York: 08:00-17:00 America/New_York, Monday-Friday.
 * Local IANA time zones keep the windows correct across DST changes.
 */
export type TradingSessionName = "LONDON" | "NEW_YORK";

export interface TradingSessionStatus {
  allowed: boolean;
  sessions: TradingSessionName[];
  checkedAt: number;
}

function localClock(timestampMs: number, timeZone: string): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function isWeekdayOpen(timestampMs: number, timeZone: string): boolean {
  const local = localClock(timestampMs, timeZone);
  const minuteOfDay = local.hour * 60 + local.minute;
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday) &&
    minuteOfDay >= 8 * 60 && minuteOfDay < 17 * 60;
}

/** Returns true only during the London or New York weekday session. */
export function getTradingSessionStatus(timestampMs: number): TradingSessionStatus {
  if (!Number.isFinite(timestampMs)) {
    return { allowed: false, sessions: [], checkedAt: timestampMs };
  }

  const sessions: TradingSessionName[] = [];
  if (isWeekdayOpen(timestampMs, "Europe/London")) sessions.push("LONDON");
  if (isWeekdayOpen(timestampMs, "America/New_York")) sessions.push("NEW_YORK");

  return { allowed: sessions.length > 0, sessions, checkedAt: timestampMs };
}

/** Feed cadence: 1m in the London/New York overlap, 4m in either individual
 * session, and 6m outside sessions only while a paper position needs exit monitoring.
 */
export function getFeedPollIntervalMs(timestampMs: number, hasOpenPosition: boolean): number | null {
  const status = getTradingSessionStatus(timestampMs);
  if (status.sessions.length === 2) return 60_000;
  if (status.sessions.length === 1) return 4 * 60_000;
  return hasOpenPosition ? 6 * 60_000 : null;
}
