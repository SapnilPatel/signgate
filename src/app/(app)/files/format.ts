/**
 * Wording helpers for the file screens. Pure, so server pages and client
 * components phrase dates and waits the same way.
 */
import type { AgreementStatus } from "@/components/ui";

const DAY_MS = 86_400_000;

/** The calendar day a moment falls on in `timeZone`, as a day count that can be subtracted. */
function dayNumber(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Math.round(Date.UTC(n("year"), n("month") - 1, n("day")) / DAY_MS);
  } catch {
    return Math.floor(at.getTime() / DAY_MS);
  }
}

function format(at: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  }
}

/** "Nov 3" this year, "Nov 3, 2025" otherwise: short enough for a table cell, never ambiguous. */
export function shortDate(at: Date, now: Date, timeZone: string): string {
  const sameYear = format(at, timeZone, { year: "numeric" }) === format(now, timeZone, { year: "numeric" });
  return format(at, timeZone, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A past day as it reads after "since" or "on": "today", "yesterday", "Tuesday", "Nov 3". */
export function pastDay(at: Date, now: Date, timeZone: string): string {
  const days = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return format(at, timeZone, { weekday: "long" });
  return shortDate(at, now, timeZone);
}

/** The same with the preposition a sentence needs: "today", "yesterday", "on Tuesday", "on Nov 3". */
export function onPastDay(at: Date, now: Date, timeZone: string): string {
  const label = pastDay(at, now, timeZone);
  return label === "today" || label === "yesterday" ? label : `on ${label}`;
}

/** A coming day: "today", "tomorrow", "on Thursday", "on Nov 18". */
export function onComingDay(at: Date, now: Date, timeZone: string): string {
  const days = dayNumber(at, timeZone) - dayNumber(now, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `on ${format(at, timeZone, { weekday: "long" })}`;
  return `on ${shortDate(at, now, timeZone)}`;
}

/** How long something has been waiting: "under an hour", "5 hours", "3 days". */
export function waitLabel(since: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - since.getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** A typical duration from seconds: "40 minutes", "6 hours", "2.5 days". */
export function durationLabel(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.round((seconds / 86_400) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

export const STATUS_FILTERS: readonly AgreementStatus[] = [
  "no_agreement",
  "out_for_signature",
  "awaiting_countersign",
  "signed",
  "declined",
  "needs_attention",
];

export function isStatusFilter(value: unknown): value is AgreementStatus {
  return typeof value === "string" && (STATUS_FILTERS as readonly string[]).includes(value);
}

/** The /files address for a view. Defaults are left out so a plain link stays plain. */
export function filesHref(view: { status?: string | null; q?: string | null; page?: number | null; archived?: boolean }): string {
  const params = new URLSearchParams();
  if (view.archived) params.set("view", "archived");
  else if (view.status) params.set("status", view.status);
  if (view.q) params.set("q", view.q);
  if (view.page && view.page > 1) params.set("page", String(view.page));
  const query = params.toString();
  return query ? `/files?${query}` : "/files";
}
