/**
 * Turns raw text runs and drawn lines into the structure the detector reasons
 * about: lines of text made of pieces, where a piece is either words or a blank
 * (a run of underscores, a dotted leader, a drawn line, or a form widget).
 * All coordinates are display points measured from the top-left of the page.
 */
import type { Field, PageInfo } from "@/lib/types";
import { groupLines, type ExtractedLayout, type RunLine, type TextRun } from "../text";

export type BlankSource = "underscore" | "dots" | "rule" | "space" | "form";

export interface Blank {
  id: string;
  page: number;
  line: Line;
  x0: number;
  x1: number;
  /** Where the writing line sits: fields are placed so their bottom edge rests here. */
  y: number;
  size: number;
  source: BlankSource;
  /** The form widget this blank came from, when source is "form". */
  form?: Field;
}

export interface Piece {
  kind: "text" | "blank";
  text: string;
  x0: number;
  x1: number;
  blank?: Blank;
}

export interface Line {
  id: string;
  page: number;
  baseline: number;
  size: number;
  pieces: Piece[];
  /** True for a line that holds only a drawn line or widget, with no text of its own. */
  synthetic: boolean;
}

export interface Model {
  pages: PageInfo[];
  lines: Line[];
  linesByPage: Line[][];
  blanks: Blank[];
}

// Approximate advance widths (thousandths of an em) of a typical sans face. Only
// the proportions matter: they are rescaled to each run's real measured width, so
// an underscore run inside "Signature: ______" lands where it is actually printed.
const NARROW = new Set("iljI.,:;'|! ".split(""));
const SEMI = new Set("frt()[]-/\"".split(""));
const WIDE = new Set("mwMW@%".split(""));

function charWidth(ch: string): number {
  if (NARROW.has(ch)) return 260;
  if (SEMI.has(ch)) return 320;
  if (WIDE.has(ch)) return 860;
  if (ch === "_") return 556;
  if (ch >= "A" && ch <= "Z") return 680;
  if (ch >= "0" && ch <= "9") return 556;
  if (ch >= "\udc00" && ch <= "\udfff") return 0; // second half of a surrogate pair
  return 530;
}

const TOKEN = /(_(?:[  ]?_){2,})|(\.{6,}|(?:\. ){5,}\.?|…{3,}|-{6,}|[—–]{4,})|([  \t]{3,})/g;

interface RawPiece {
  kind: "text" | "blank";
  source?: BlankSource;
  text: string;
  x0: number;
  x1: number;
  /** A deliberate gap (several spaces) preceded this piece, so it starts a new column. */
  hardBreak: boolean;
}

function splitRun(run: TextRun): RawPiece[] {
  const text = run.text;
  const cumulative: number[] = [0];
  for (let i = 0; i < text.length; i++) cumulative.push(cumulative[i] + charWidth(text[i]));
  const total = cumulative[text.length] || 1;
  const width = run.width > 0 ? run.width : (total / 1000) * run.size;
  const at = (index: number) => run.x + (cumulative[index] / total) * width;

  const out: RawPiece[] = [];
  let hardBreak = false;
  const pushText = (from: number, to: number) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) {
      out.push({ kind: "text", text: text.slice(a, b), x0: at(a), x1: at(b), hardBreak });
      hardBreak = false;
    }
  };
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
    pushText(last, match.index);
    const end = match.index + match[0].length;
    if (match[1] || match[2]) {
      out.push({
        kind: "blank",
        source: match[1] ? "underscore" : "dots",
        text: match[0],
        x0: at(match.index),
        x1: at(end),
        hardBreak,
      });
      hardBreak = false;
    } else {
      hardBreak = true;
    }
    last = end;
  }
  pushText(last, text.length);
  return out;
}

function buildPieces(line: RunLine): RawPiece[] {
  const raw = line.runs.flatMap(splitRun).sort((a, b) => a.x0 - b.x0);
  const merged: RawPiece[] = [];
  for (const piece of raw) {
    const prev = merged[merged.length - 1];
    const gap = prev ? piece.x0 - prev.x1 : 0;
    if (prev && prev.kind === "text" && piece.kind === "text" && !piece.hardBreak && gap <= 1.6 * line.size) {
      prev.text += (gap > 0.15 * line.size ? " " : "") + piece.text;
      prev.x1 = Math.max(prev.x1, piece.x1);
    } else if (prev && prev.kind === "blank" && piece.kind === "blank" && prev.source === piece.source && gap <= 0.6 * line.size) {
      prev.x1 = Math.max(prev.x1, piece.x1);
    } else {
      merged.push({ ...piece });
    }
  }
  // "____/____/____" is one date written in three parts, not three separate blanks.
  const joined: RawPiece[] = [];
  for (let i = 0; i < merged.length; i++) {
    const piece = merged[i];
    const prev = joined[joined.length - 1];
    const next = merged[i + 1];
    if (prev && next && prev.kind === "blank" && next.kind === "blank" && piece.kind === "text" && /^[/\-.]$/.test(piece.text) && next.x0 - prev.x1 <= 1.5 * line.size) {
      prev.x1 = next.x1;
      i++;
    } else {
      joined.push(piece);
    }
  }
  return joined;
}

function median(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The parts of [x0, x1] not covered by any of the intervals; longest first. */
function freeSegments(x0: number, x1: number, covered: [number, number][]): [number, number][] {
  let segments: [number, number][] = [[x0, x1]];
  for (const [c0, c1] of covered) {
    segments = segments.flatMap(([s0, s1]): [number, number][] => {
      if (c1 <= s0 || c0 >= s1) return [[s0, s1]];
      const parts: [number, number][] = [];
      if (c0 > s0) parts.push([s0, c0]);
      if (c1 < s1) parts.push([c1, s1]);
      return parts;
    });
  }
  return segments.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
}

export function buildModel(layout: ExtractedLayout, formFields: Field[] = []): Model {
  const pages = layout.pages;
  const linesByPage: Line[][] = pages.map(() => []);
  const blanks: Blank[] = [];

  for (const runLine of groupLines(layout.runs)) {
    if (!linesByPage[runLine.page]) continue;
    const line: Line = { id: "", page: runLine.page, baseline: runLine.baseline, size: runLine.size, pieces: [], synthetic: false };
    for (const raw of buildPieces(runLine)) {
      const piece: Piece = { kind: raw.kind, text: raw.text, x0: raw.x0, x1: raw.x1 };
      if (raw.kind === "blank") {
        // Underscores are printed a little below the baseline.
        piece.blank = { id: "", page: line.page, line, x0: raw.x0, x1: raw.x1, y: line.baseline + 0.12 * line.size, size: line.size, source: raw.source ?? "underscore" };
        blanks.push(piece.blank);
      }
      line.pieces.push(piece);
    }
    if (line.pieces.length) linesByPage[line.page].push(line);
  }

  const bodySize = pages.map((_, i) => median(linesByPage[i].map((l) => l.size), 11));

  const attach = (page: number, x0: number, x1: number, y: number, source: BlankSource, hostBaselines: [number, number], form?: Field) => {
    const lines = linesByPage[page];
    let host: Line | undefined;
    for (const line of lines) {
      if (line.synthetic) continue;
      const lo = hostBaselines[0] === Number.NEGATIVE_INFINITY ? y - 0.75 * line.size : hostBaselines[0];
      const hi = hostBaselines[1] === Number.POSITIVE_INFINITY ? y + 0.3 * line.size : hostBaselines[1];
      if (line.baseline >= lo && line.baseline <= hi && (!host || Math.abs(line.baseline - y) < Math.abs(host.baseline - y))) host = line;
    }
    let bx0 = x0;
    let bx1 = x1;
    if (host && source === "rule") {
      const texts = host.pieces.filter((p) => p.kind === "text" && p.x1 > x0 && p.x0 < x1);
      const coveredWidth = texts.reduce((sum, p) => sum + Math.min(p.x1, x1) - Math.max(p.x0, x0), 0);
      // A line that runs under the words themselves is an underline, not a place to write.
      if (coveredWidth >= 0.5 * (x1 - x0)) return;
      const free = freeSegments(x0, x1, texts.map((p): [number, number] => [p.x0 - 3, p.x1 + 3]))[0];
      if (!free || free[1] - free[0] < 28) return;
      [bx0, bx1] = free;
      // The same blank is sometimes both typed as underscores and drawn.
      if (host.pieces.some((p) => p.kind === "blank" && p.x1 > bx0 + 4 && p.x0 < bx1 - 4)) return;
    }
    if (!host) {
      host = { id: "", page, baseline: y, size: bodySize[page], pieces: [], synthetic: true };
      lines.push(host);
    }
    const blank: Blank = { id: "", page, line: host, x0: bx0, x1: bx1, y, size: host.size, source, form };
    host.pieces.push({ kind: "blank", text: "", x0: bx0, x1: bx1, blank });
    host.pieces.sort((a, b) => a.x0 - b.x0);
    blanks.push(blank);
  };

  for (const rule of layout.rules) {
    const size = pages[rule.page];
    if (!size) continue;
    // Page-wide lines are separators, header rules and table edges.
    if (rule.x1 - rule.x0 > 0.85 * size.width) continue;
    attach(rule.page, rule.x0, rule.x1, rule.y, "rule", [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
  }

  for (const field of formFields) {
    const size = pages[field.page];
    if (!size || !Number.isFinite(field.x + field.y + field.w + field.h)) continue;
    const top = field.y * size.height;
    const bottom = (field.y + field.h) * size.height;
    attach(field.page, field.x * size.width, (field.x + field.w) * size.width, bottom, "form", [top, bottom + 3], field);
  }

  const lines: Line[] = [];
  linesByPage.forEach((pageLines, page) => {
    pageLines.sort((a, b) => a.baseline - b.baseline);
    pageLines.forEach((line, i) => {
      line.id = `p${page + 1}l${i + 1}`;
      lines.push(line);
    });
  });
  blanks.sort((a, b) => a.page - b.page || a.y - b.y || a.x0 - b.x0);
  blanks.forEach((blank, i) => (blank.id = `b${i + 1}`));
  return { pages, lines, linesByPage, blanks };
}

/** A line as plain text, with each blank shown as a marker. Used for context and for the AI pass. */
export function renderLine(line: Line): string {
  return line.pieces.map((p) => (p.kind === "blank" ? "[blank]" : p.text)).join("  ");
}

const DESIRED_HEIGHT: Record<string, number> = { signature: 36, initials: 24, checkbox: 12 };
const MAX_WIDTH: Record<string, number> = { signature: 280, initials: 90, date_signed: 170, date: 170 };

/**
 * The box for a field of the given type on a blank: resting on the writing line,
 * as tall as the type wants but never reaching into the text or line above it.
 */
export function rectFor(model: Model, blank: Pick<Blank, "page" | "x0" | "x1" | "y" | "size" | "line">, type: string): { x: number; y: number; w: number; h: number } {
  const size = model.pages[blank.page];
  const x0 = Math.max(0, blank.x0);
  const x1 = Math.min(size.width, Math.max(blank.x1, x0 + 12), x0 + (MAX_WIDTH[type] ?? Number.POSITIVE_INFINITY));
  const desired = DESIRED_HEIGHT[type] ?? Math.max(14, Math.min(22, blank.size * 1.5));
  let ceiling = 0; // lowest obstruction above the writing line
  for (const line of model.linesByPage[blank.page] ?? []) {
    if (line === blank.line || line.baseline >= blank.y - 2) continue;
    for (const piece of line.pieces) {
      if (piece.x1 <= x0 || piece.x0 >= x1) continue;
      const bottom = piece.kind === "blank" ? (piece.blank?.y ?? line.baseline) + 1 : line.baseline + 0.22 * line.size;
      if (bottom < blank.y && bottom > ceiling) ceiling = bottom;
    }
  }
  const minimum = type === "signature" ? 16 : 10;
  const height = Math.max(minimum, Math.min(desired, blank.y - ceiling - 1));
  const top = Math.max(0, blank.y - height);
  return {
    x: x0 / size.width,
    y: top / size.height,
    w: (x1 - x0) / size.width,
    h: Math.min(height, blank.y - top) / size.height,
  };
}
