/**
 * Turns raw text runs and drawn lines into the structure the detector reasons
 * about: lines of text made of pieces, where a piece is either words or a blank
 * (a run of underscores, a dotted leader, a drawn line, or a form widget).
 * All coordinates are display points measured from the top-left of the page.
 */
import type { Field, PageInfo } from "@/lib/types";
import { groupLines, type ExtractedLayout, type RuleLine, type RunLine, type TextRun, type VerticalRule } from "../text";

/** "cell": the empty part of a bordered table cell that a label points at. */
export type BlankSource = "underscore" | "dots" | "rule" | "space" | "form" | "cell";

/**
 * Bounds on how much of a document the rules reason about. A real agreement has
 * a few dozen blanks; these exist so a file made of nothing but blanks is answered
 * in bounded time instead of pinning a serverless function.
 */
export const MAX_BLANKS_PER_PAGE = 400;
export const MAX_BLANKS_TOTAL = 3000;

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
  /** The highest a field on this blank may reach (the top edge of its table cell). */
  top?: number;
  /** A drawn line with no text of its own that spans the whole text column. */
  fullWidth?: boolean;
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

/** A bordered table cell, in display points. */
export interface Cell {
  page: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Model {
  pages: PageInfo[];
  lines: Line[];
  linesByPage: Line[][];
  blanks: Blank[];
  /** The table cell around a point, when the point lies inside a drawn grid. */
  cellAt(page: number, x: number, y: number): Cell | null;
  /** How many blanks were left out because the document has more than the rules will consider. */
  skippedBlanks: number;
}

const TOUCH = 2.5;

interface PageGrid {
  /** Horizontal lines that are table borders: at least two vertical lines meet them. */
  edges: RuleLine[];
  verticals: VerticalRule[];
}

/**
 * Separates table borders from lines to write on. A horizontal line met by two or
 * more vertical lines is the edge of a cell; a signature line never is.
 */
function findGrid(rules: RuleLine[], verticals: VerticalRule[]): { grid: PageGrid; isEdge: Set<RuleLine> } {
  const isEdge = new Set<RuleLine>();
  // Bounded work per page: a page with thousands of lines both ways is not a signature table.
  if (!verticals.length || rules.length * verticals.length > 400_000) return { grid: { edges: [], verticals: [] }, isEdge };
  const meet = (rule: RuleLine, v: VerticalRule) => v.x >= rule.x0 - TOUCH && v.x <= rule.x1 + TOUCH && rule.y >= v.y0 - TOUCH && rule.y <= v.y1 + TOUCH;
  // A vertical line that joins two or more horizontal ones is a column divider, even when it is
  // the only one (a table drawn without its outer sides).
  const dividers = new Set<VerticalRule>();
  for (const v of verticals) {
    let meets = 0;
    for (const rule of rules) if (meet(rule, v) && ++meets >= 2) break;
    if (meets >= 2) dividers.add(v);
  }
  for (const rule of rules) {
    let meets = 0;
    let divided = false;
    for (const v of verticals) {
      if (!meet(rule, v)) continue;
      if (dividers.has(v)) divided = true;
      if (++meets >= 2) break;
    }
    if (meets >= 2 || divided) isEdge.add(rule);
  }
  return { grid: { edges: rules.filter((r) => isEdge.has(r)), verticals }, isEdge };
}

function cellIn(grid: PageGrid | undefined, size: PageInfo, page: number, x: number, y: number): Cell | null {
  if (!grid || grid.edges.length < 2) return null;
  let above: RuleLine | undefined;
  let under: RuleLine | undefined;
  for (const e of grid.edges) {
    if (x < e.x0 - TOUCH || x > e.x1 + TOUCH) continue;
    if (e.y <= y && (!above || e.y > above.y)) above = e;
    if (e.y > y && (!under || e.y < under.y)) under = e;
  }
  if (!above || !under) return null;
  const top = above.y;
  const bottom = under.y;
  let left = Number.NEGATIVE_INFINITY;
  let right = Number.POSITIVE_INFINITY;
  for (const v of grid.verticals) {
    // The edge must run along this cell, not merely pass a corner of it.
    if (Math.min(v.y1, bottom) - Math.max(v.y0, top) < 0.5 * (bottom - top)) continue;
    if (v.x <= x && v.x > left) left = v.x;
    if (v.x > x && v.x < right) right = v.x;
  }
  // Tables are often drawn without their outer sides: the row lines themselves end the outer cells.
  // At least one divider must cross the row, or this is just the gap between two unrelated lines.
  if (!Number.isFinite(left) && !Number.isFinite(right)) return null;
  if (!Number.isFinite(left)) left = Math.max(above.x0, under.x0);
  if (!Number.isFinite(right)) right = Math.min(above.x1, under.x1);
  if (x < left - TOUCH || x > right + TOUCH) return null;
  if (right - left < 20 || bottom - top < 9) return null;
  // A frame around the page or around a whole section is not a cell.
  if (bottom - top > 0.4 * size.height && right - left > 0.6 * size.width) return null;
  return { page, x0: left, x1: right, y0: top, y1: bottom };
}

/** The text pieces printed inside a cell. */
export function piecesInCell(model: Model, cell: Cell): { line: Line; piece: Piece }[] {
  const out: { line: Line; piece: Piece }[] = [];
  for (const line of model.linesByPage[cell.page] ?? []) {
    if (line.synthetic) continue;
    const mid = line.baseline - 0.3 * line.size;
    if (mid <= cell.y0 || mid >= cell.y1) continue;
    for (const piece of line.pieces) {
      const cx = (piece.x0 + piece.x1) / 2;
      if (cx > cell.x0 && cx < cell.x1) out.push({ line, piece });
    }
  }
  return out;
}

/** Left and right edges of the body text, taken from the lines that run the width of the column. */
function textColumn(pages: PageInfo[], linesByPage: Line[][]): { left: number; right: number } | null {
  const lefts: number[] = [];
  const rights: number[] = [];
  linesByPage.forEach((lines, page) => {
    for (const line of lines) {
      if (line.synthetic || !line.pieces.length) continue;
      const x0 = line.pieces[0].x0;
      const x1 = line.pieces[line.pieces.length - 1].x1;
      if (x1 - x0 >= 0.5 * pages[page].width) {
        lefts.push(x0);
        rights.push(x1);
      }
    }
  });
  if (lefts.length < 3) return null;
  return { left: median(lefts, 0), right: median(rights, 0) };
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

interface TypeScale {
  /** How much wider or narrower this document's type is than the width table above. */
  text: number;
  /** Width of one underscore as a share of the font size, when the document shows it. */
  underscore: number | null;
}

/**
 * Measures the document's own type on ordinary lines of text, and its underscore on
 * the runs that are mostly underscores (where the guess about the words matters least).
 * Null when there is too little text to tell.
 */
function typeScale(runs: TextRun[]): TypeScale | null {
  const ratios: number[] = [];
  for (const run of runs) {
    if (run.text.length < 25 || !(run.width > 0) || !(run.size > 0) || /_|\.{4,}|\s{3,}/.test(run.text)) continue;
    let units = 0;
    for (const ch of run.text) units += charWidth(ch);
    ratios.push(run.width / ((units / 1000) * run.size));
    if (ratios.length >= 400) break;
  }
  if (ratios.length < 3) return null;
  const text = median(ratios, 1);
  const ems: number[] = [];
  for (const run of runs) {
    const count = run.text.split("_").length - 1;
    if (count < 8 || count < 0.6 * run.text.length || !(run.width > 0) || !(run.size > 0)) continue;
    let others = 0;
    for (const ch of run.text) if (ch !== "_") others += charWidth(ch);
    ems.push((run.width - text * (others / 1000) * run.size) / count / run.size);
    if (ems.length >= 200) break;
  }
  const underscore = ems.length ? median(ems, 0) : null;
  return { text, underscore: underscore && underscore >= 0.35 && underscore <= 0.85 ? underscore : null };
}

function splitRun(run: TextRun, scale: TypeScale | null): RawPiece[] {
  const text = run.text;
  const widths: number[] = [];
  for (let i = 0; i < text.length; i++) widths.push(charWidth(text[i]));
  // The underscore is the one glyph whose width varies wildly between typefaces (half
  // an em in some, two thirds in others), and a blank is made of nothing else. Without
  // its real width a blank after printed text ("20____") is placed on top of that text.
  const underscores = text.split("_").length - 1;
  if (scale && underscores >= 3 && run.width > 0 && run.size > 0) {
    let others = 0;
    for (let i = 0; i < text.length; i++) if (text[i] !== "_") others += widths[i];
    // Prefer the width measured across the document; otherwise what this run's words leave over.
    let each = scale.underscore ? scale.underscore * run.size : (run.width - scale.text * (others / 1000) * run.size) / underscores;
    let perUnit = scale.text * (run.size / 1000);
    if (scale.underscore && others > 0) {
      const rest = run.width - each * underscores;
      // The words must still fit believably beside the blanks, or the measurement does not apply to this run.
      if (rest > 0.6 * perUnit * others && rest < 1.6 * perUnit * others) perUnit = rest / others;
      else each = (run.width - perUnit * others) / underscores;
    }
    if (each >= 0.35 * run.size && each <= 0.85 * run.size) {
      for (let i = 0; i < text.length; i++) widths[i] = text[i] === "_" ? each : perUnit * widths[i];
    }
  }
  const cumulative: number[] = [0];
  for (let i = 0; i < text.length; i++) cumulative.push(cumulative[i] + widths[i]);
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

function buildPieces(line: RunLine, scale: TypeScale | null): RawPiece[] {
  const raw = line.runs.flatMap((run) => splitRun(run, scale)).sort((a, b) => a.x0 - b.x0);
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

  const scale = typeScale(layout.runs);
  for (const runLine of groupLines(layout.runs)) {
    if (!linesByPage[runLine.page]) continue;
    const line: Line = { id: "", page: runLine.page, baseline: runLine.baseline, size: runLine.size, pieces: [], synthetic: false };
    for (const raw of buildPieces(runLine, scale)) {
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

  const column = textColumn(pages, linesByPage);
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
    if (source === "rule" && host.synthetic && column) {
      const slack = 0.03 * (column.right - column.left);
      if (x0 <= column.left + slack && x1 >= column.right - slack && x1 - x0 >= 0.5 * pages[page].width) blank.fullWidth = true;
    }
    host.pieces.push({ kind: "blank", text: "", x0: bx0, x1: bx1, blank });
    host.pieces.sort((a, b) => a.x0 - b.x0);
    blanks.push(blank);
  };

  const rulesByPage: RuleLine[][] = pages.map(() => []);
  const verticalsByPage: VerticalRule[][] = pages.map(() => []);
  for (const rule of layout.rules) rulesByPage[rule.page]?.push(rule);
  for (const rule of layout.vrules ?? []) verticalsByPage[rule.page]?.push(rule);

  // A wide line at the same place on most pages is page furniture (a header or footer rule).
  const repeats = new Map<string, number>();
  const repeatKey = (rule: RuleLine) => `${Math.round(rule.x0 / 3)}:${Math.round(rule.x1 / 3)}:${Math.round(rule.y / 3)}`;
  for (const pageRules of rulesByPage) {
    const seen = new Set<string>();
    for (const rule of pageRules) {
      const key = repeatKey(rule);
      if (!seen.has(key)) {
        seen.add(key);
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
      }
    }
  }
  const pagesWithRules = rulesByPage.filter((r) => r.length > 0).length;

  const grids: (PageGrid | undefined)[] = pages.map(() => undefined);
  rulesByPage.forEach((pageRules, page) => {
    const size = pages[page];
    const { grid, isEdge } = findGrid(pageRules, verticalsByPage[page]);
    grids[page] = grid;
    for (const rule of pageRules) {
      const width = rule.x1 - rule.x0;
      // Page-wide lines are separators, header rules and table edges.
      if (width > 0.85 * size.width) continue;
      // The border of a table cell is not a line to write on; cells are read on their own.
      if (isEdge.has(rule)) continue;
      if (width >= 0.5 * size.width) {
        const edge = Math.min(rule.y, size.height - rule.y) / size.height;
        // Running headers and footers are ruled off from the body: nobody signs in the page margin on a line that wide.
        if (edge < 0.08) continue;
        const count = repeats.get(repeatKey(rule)) ?? 0;
        if (edge < 0.15 && count >= 2 && count >= 0.5 * pagesWithRules) continue;
      }
      attach(rule.page, rule.x0, rule.x1, rule.y, "rule", [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
    }
  });

  for (const field of formFields) {
    const size = pages[field.page];
    if (!size || !Number.isFinite(field.x + field.y + field.w + field.h)) continue;
    const top = field.y * size.height;
    const bottom = (field.y + field.h) * size.height;
    attach(field.page, field.x * size.width, (field.x + field.w) * size.width, bottom, "form", [top, bottom + 3], field);
  }

  // ---- Bound the work: keep the blanks most likely to matter ------------------
  blanks.sort((a, b) => a.page - b.page || a.y - b.y || a.x0 - b.x0);
  const keep = new Set<Blank>();
  const perPage: Blank[][] = pages.map(() => []);
  for (const blank of blanks) {
    // Form widgets were chosen by the document's author and are already capped at ingest.
    if (blank.form) keep.add(blank);
    else if (perPage[blank.page].length < MAX_BLANKS_PER_PAGE) perPage[blank.page].push(blank);
  }
  let budget = MAX_BLANKS_TOTAL;
  // Agreements are signed at the end, so the last pages with blanks are kept before the rest.
  const withBlanks = perPage.map((list, page) => ({ list, page })).filter((p) => p.list.length);
  const order = [...withBlanks.slice(-2).reverse(), ...withBlanks.slice(0, -2)];
  for (const { list } of order) {
    for (const blank of list) {
      if (budget <= 0) break;
      keep.add(blank);
      budget--;
    }
  }
  const skippedBlanks = blanks.length - keep.size;
  if (skippedBlanks > 0) {
    for (const pageLines of linesByPage) {
      for (const line of pageLines) {
        if (line.pieces.some((p) => p.blank && !keep.has(p.blank))) line.pieces = line.pieces.filter((p) => !p.blank || keep.has(p.blank));
      }
    }
    linesByPage.forEach((pageLines, page) => (linesByPage[page] = pageLines.filter((l) => l.pieces.length > 0)));
    blanks.splice(0, blanks.length, ...blanks.filter((b) => keep.has(b)));
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
  const cellAt = (page: number, x: number, y: number): Cell | null => (pages[page] ? cellIn(grids[page], pages[page], page, x, y) : null);
  return { pages, lines, linesByPage, blanks, cellAt, skippedBlanks };
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
export function rectFor(model: Model, blank: Pick<Blank, "page" | "x0" | "x1" | "y" | "size" | "line" | "top">, type: string): { x: number; y: number; w: number; h: number } {
  const size = model.pages[blank.page];
  const x0 = Math.max(0, blank.x0);
  const x1 = Math.min(size.width, Math.max(blank.x1, x0 + 12), x0 + (MAX_WIDTH[type] ?? Number.POSITIVE_INFINITY));
  const desired = DESIRED_HEIGHT[type] ?? Math.max(14, Math.min(22, blank.size * 1.5));
  let ceiling = blank.top ?? 0; // lowest obstruction above the writing line
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
