/**
 * Pure helpers for the field editor: geometry, defaults and the words used for
 * field types, roles and file details. No React and no server imports, so every
 * part of the editor (and its tests) can use them.
 *
 * All geometry is in fractions of the displayed page with a top-left origin,
 * exactly as stored on Field. Nothing here knows about pixels or PDF points.
 */
import type { Field, FieldRole, FieldType, MergeKey, PageInfo } from "@/lib/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest box the editor lets a person make: comfortably above the server's floor and still grabbable. */
export const MIN_W = 0.012;
export const MIN_H = 0.008;

/** Below this the detector was unsure, and the field is flagged for a second look. */
export const LOW_CONFIDENCE = 0.6;

export const FIELD_TYPES: readonly FieldType[] = ["signature", "initials", "date_signed", "full_name", "title", "company", "email", "text", "date", "checkbox"];
export const FIELD_ROLES: readonly FieldRole[] = ["client", "company", "prefill"];

/** Types that only exist at the moment someone signs, so they cannot be filled automatically. */
export const SIGNING_ONLY: readonly FieldType[] = ["signature", "initials", "date_signed"];

export const TYPE_LABEL: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date_signed: "Date signed",
  full_name: "Name",
  title: "Title",
  company: "Company",
  email: "Email",
  text: "Text",
  date: "Date",
  checkbox: "Checkbox",
};

export const TYPE_HINT: Record<FieldType, string> = {
  signature: "The person draws or types their signature.",
  initials: "The person adds their initials.",
  date_signed: "Filled with the date at the moment the person signs. Nobody types it.",
  full_name: "The person's full name.",
  title: "The person's job title.",
  company: "The name of the person's company.",
  email: "The person's email address.",
  text: "Any short answer.",
  date: "A date the person chooses, such as a start date.",
  checkbox: "A box the person ticks.",
};

export const ROLE_LABEL: Record<FieldRole, string> = {
  client: "The client",
  company: "Your company",
  prefill: "Filled automatically",
};

export const ROLE_SHORT: Record<FieldRole, string> = {
  client: "Client",
  company: "Your company",
  prefill: "Automatic",
};

export const ROLE_HINT: Record<FieldRole, string> = {
  client: "The client fills this in while signing.",
  company: "The person who countersigns for your company fills this in.",
  prefill: "Filled in from the file before the agreement is sent. Nobody types it.",
};

/**
 * Colours by who fills the field. The yellow sign-here flag belongs to the client:
 * those are the boxes an agreement waits on. Your company is ink blue, and automatic
 * fields are plain grey because nobody has to act on them.
 */
export const ROLE_BOX: Record<FieldRole, string> = {
  client: "bg-flag/45 border-flag-ink/70 text-flag-ink",
  company: "bg-note/15 border-note text-note",
  prefill: "bg-ink-faint/15 border-ink-faint text-ink-soft",
};

export const ROLE_SWATCH: Record<FieldRole, string> = {
  client: "bg-flag border-flag-ink/70",
  company: "bg-note/30 border-note",
  prefill: "bg-ink-faint/30 border-ink-faint",
};

/** File details an automatic field can show, in the order people look for them. */
export const MERGE_OPTIONS: readonly { key: MergeKey; label: string }[] = [
  { key: "client_name", label: "Client's name" },
  { key: "client_email", label: "Client's email" },
  { key: "client_company", label: "Client's company" },
  { key: "client_title", label: "Client's title" },
  { key: "client_phone", label: "Client's phone" },
  { key: "file_reference", label: "File reference" },
  { key: "file_description", label: "File description" },
  { key: "company_name", label: "Your company's name" },
  { key: "today", label: "Today's date (the day it is sent)" },
  { key: "custom:today_day", label: "Today: day of the month" },
  { key: "custom:today_month", label: "Today: month" },
  { key: "custom:today_month_day", label: "Today: month and day" },
  { key: "custom:today_year", label: "Today: year" },
  { key: "custom:today_year_short", label: "Today: two-digit year" },
];

const CUSTOM_KEY = /^[A-Za-z0-9_.-]{1,60}$/;

/** True for a file detail the company defines itself (a key in the file's extra details). */
export function isOwnCustomKey(key: MergeKey | undefined): boolean {
  return typeof key === "string" && key.startsWith("custom:") && !MERGE_OPTIONS.some((o) => o.key === key);
}

export function customKeyProblem(name: string): string | null {
  if (name === "") return "Type the name of the file detail, for example matter_type.";
  if (!CUSTOM_KEY.test(name)) return "Use only letters, numbers, dots, dashes and underscores, up to 60 characters.";
  return null;
}

export function mergeLabel(key: MergeKey | undefined): string {
  if (!key) return "Not chosen yet";
  const known = MERGE_OPTIONS.find((o) => o.key === key);
  if (known) return known.label;
  return key.startsWith("custom:") ? `File detail "${key.slice("custom:".length)}"` : key;
}

/** The most likely file detail for a field that has just been switched to automatic. */
export function defaultMergeKey(type: FieldType): MergeKey {
  switch (type) {
    case "full_name":
      return "client_name";
    case "email":
      return "client_email";
    case "company":
      return "client_company";
    case "title":
      return "client_title";
    case "date":
      return "today";
    default:
      return "file_reference";
  }
}

/** The label a field gets when nobody has named it. Mirrors the server so a save does not rename anything. */
export function defaultLabel(role: FieldRole, type: FieldType): string {
  const what = type === "full_name" ? "name" : TYPE_LABEL[type].toLowerCase();
  if (role === "client") return `Client ${what}`;
  if (role === "company") return `Company ${what}`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
}

/** Typical size of each kind of field in PDF points, converted per page so a signature looks the same on Letter and A4. */
const DEFAULT_POINTS: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 190, h: 42 },
  initials: { w: 60, h: 34 },
  date_signed: { w: 100, h: 20 },
  full_name: { w: 180, h: 20 },
  title: { w: 160, h: 20 },
  company: { w: 180, h: 20 },
  email: { w: 190, h: 20 },
  text: { w: 180, h: 20 },
  date: { w: 100, h: 20 },
  checkbox: { w: 14, h: 14 },
};

export function defaultSize(type: FieldType, page: PageInfo | undefined): { w: number; h: number } {
  const points = DEFAULT_POINTS[type];
  const width = page && page.width > 0 ? page.width : 612;
  const height = page && page.height > 0 ? page.height : 792;
  return { w: Math.min(1, Math.max(MIN_W, points.w / width)), h: Math.min(1, Math.max(MIN_H, points.h / height)) };
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/** Pull a box fully onto the page, shrinking it only when it is larger than the page. */
export function clampRect(r: Rect): Rect {
  const w = Math.min(1, Math.max(MIN_W, r.w));
  const h = Math.min(1, Math.max(MIN_H, r.h));
  return { x: round(Math.min(1 - w, Math.max(0, r.x))), y: round(Math.min(1 - h, Math.max(0, r.y))), w: round(w), h: round(h) };
}

export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
}

/** Which edges a resize handle moves, as compass points. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * Resize by dragging a handle. The opposite edge stays where it is; the dragged
 * edge stops at the page edge and at the minimum size instead of pushing the box.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number): Rect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.w;
  let bottom = r.y + r.h;
  if (handle.includes("w")) left = Math.min(right - MIN_W, Math.max(0, left + dx));
  if (handle.includes("e")) right = Math.max(left + MIN_W, Math.min(1, right + dx));
  if (handle.includes("n")) top = Math.min(bottom - MIN_H, Math.max(0, top + dy));
  if (handle.includes("s")) bottom = Math.max(top + MIN_H, Math.min(1, bottom + dy));
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

/** The box between two points on a page, in any drag direction. */
export function rectBetween(ax: number, ay: number, bx: number, by: number): Rect {
  const x = Math.max(0, Math.min(ax, bx));
  const y = Math.max(0, Math.min(ay, by));
  return { x, y, w: Math.min(1, Math.max(ax, bx)) - x, h: Math.min(1, Math.max(ay, by)) - y };
}

export function newFieldId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
  return `fld_${random.slice(0, 20)}`;
}

export function newField(type: FieldType, role: FieldRole, page: number, rect: Rect): Field {
  const field: Field = {
    id: newFieldId(),
    page,
    ...clampRect(rect),
    type,
    role,
    // A signature nobody has to give defeats the point; everything else starts optional only for automatic fields.
    required: role !== "prefill",
    label: defaultLabel(role, type),
    source: "manual",
  };
  if (role === "prefill") field.mergeKey = defaultMergeKey(type);
  return field;
}

/** True when the detector was unsure about this field and nobody has confirmed it since. */
export function needsLook(field: Field): boolean {
  return field.source !== "manual" && typeof field.confidence === "number" && field.confidence < LOW_CONFIDENCE;
}

/** A field a person has touched or approved no longer needs a second look. */
export function confirmed(field: Field): Field {
  return typeof field.confidence === "number" && field.confidence < 1 ? { ...field, confidence: 1 } : field;
}

/**
 * Apply a change of type, role or file detail and keep the field consistent:
 * automatic fields always name a file detail, others never do, and a label that
 * was still the default follows the change.
 */
export function withChange(field: Field, change: Partial<Pick<Field, "type" | "role" | "required" | "label" | "mergeKey">>): Field {
  const next: Field = confirmed({ ...field, ...change });
  if (next.role === "prefill" && SIGNING_ONLY.includes(next.type)) {
    // Cannot happen through the controls (the options are disabled); keep the field valid if it does.
    next.role = field.role === "prefill" ? "client" : field.role;
  }
  if (next.role === "prefill") {
    if (!next.mergeKey) next.mergeKey = defaultMergeKey(next.type);
  } else {
    delete next.mergeKey;
  }
  if (change.label === undefined && (field.label === "" || field.label === defaultLabel(field.role, field.type))) {
    next.label = defaultLabel(next.role, next.type);
  }
  return next;
}

/** Fields in reading order: by page, then top to bottom, then left to right. */
export function inReadingOrder(fields: readonly Field[]): Field[] {
  return [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

/** One line describing a field for lists and screen readers. */
export function describeField(field: Field): string {
  const who = field.role === "prefill" ? `filled automatically with ${mergeLabel(field.mergeKey).toLowerCase()}` : `filled by ${ROLE_LABEL[field.role].toLowerCase()}`;
  return `${field.label || defaultLabel(field.role, field.type)}, ${TYPE_LABEL[field.type].toLowerCase()}, ${who}, page ${field.page + 1}${field.required ? ", required" : ""}`;
}
