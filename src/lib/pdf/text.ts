/**
 * Reads the text layer of a PDF with positions, plus the thin horizontal and
 * vertical lines drawn on each page (signature lines, and the borders of tables and boxes). Everything is expressed in display space (the page as a
 * reader sees it, after rotation and crop box), which is what Field geometry uses.
 *
 * Runs on pdf.js through unpdf's serverless build: no worker, no canvas, no
 * native code. Nothing here throws: an unreadable document comes back as empty
 * text with `scanned: true`, which downstream treats as "no usable text layer".
 */
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import type { PageInfo } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import type { ExtractedText, TextItem } from "./types";

/** A run of text in display points. `baseline` is measured from the top of the page. */
export interface TextRun {
  page: number;
  text: string;
  x: number;
  baseline: number;
  width: number;
  /** Font size in points as displayed. */
  size: number;
}

/** A thin horizontal line drawn as vector graphics, in display points from the top-left. */
export interface RuleLine {
  page: number;
  x0: number;
  x1: number;
  y: number;
}

/** A thin vertical line drawn as vector graphics (a table or box edge), in display points from the top-left. */
export interface VerticalRule {
  page: number;
  x: number;
  y0: number;
  y1: number;
}

/** A line of text assembled from runs that share a baseline. */
export interface RunLine {
  page: number;
  baseline: number;
  size: number;
  runs: TextRun[];
}

export interface ExtractedLayout extends ExtractedText {
  /** Displayed size of every page in points (empty when the document could not be read). */
  pages: PageInfo[];
  /** Horizontal text only; rotated text (watermarks, margin notes) is left out. */
  runs: TextRun[];
  rules: RuleLine[];
  /** Vertical edges. Together with `rules` they show which lines are table borders rather than places to write. */
  vrules?: VerticalRule[];
}

type Matrix = [number, number, number, number, number, number];

/** Pages whose drawing instructions are scanned first for signature lines. */
const LINE_HINT = /sign|initial|witness|\bby\b|name|date|title|print|agree|accept|client|customer/i;
/** Scanning drawing instructions is the slow part; text alone still gives a usable result. */
const RULES_TIME_BUDGET_MS = 3500;
/** Reading text is fast for real agreements; a file built to be slow is cut off here, except for its last pages, where agreements are signed. */
const TEXT_TIME_BUDGET_MS = 6000;
const MIN_RULE_WIDTH = 28;
const MAX_RULE_THICKNESS = 2.6;
const MIN_VERTICAL_LENGTH = 8;
/** A page of graph paper or a hostile file can hold any number of lines; no agreement needs more than this to be understood. */
const MAX_RULES_PER_PAGE = 1500;
const MAX_SEGMENTS_PER_PATH = 4000;
/**
 * Text runs kept per page and per document. Some PDFs store every character as its own run, so
 * the page limit has to allow a dense page written that way; the document limit is what stops
 * a file built to exhaust memory.
 */
const MAX_RUNS_PER_PAGE = 20_000;
const MAX_RUNS_TOTAL = 800_000;

const EMPTY: ExtractedLayout = { items: [], pageText: [], scanned: true, pages: [], runs: [], rules: [], vrules: [] };

function multiply(m1: ArrayLike<number>, m2: ArrayLike<number>): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function isMatrix(value: unknown): value is ArrayLike<number> {
  if (!value || typeof value !== "object") return false;
  const m = value as ArrayLike<number>;
  for (let i = 0; i < 6; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Groups runs into lines by baseline, top to bottom, each line left to right. */
export function groupLines(runs: TextRun[]): RunLine[] {
  const byPage = new Map<number, TextRun[]>();
  for (const run of runs) {
    const list = byPage.get(run.page);
    if (list) list.push(run);
    else byPage.set(run.page, [run]);
  }
  const lines: RunLine[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const sorted = byPage.get(page)!.slice().sort((a, b) => a.baseline - b.baseline || a.x - b.x);
    let current: RunLine | null = null;
    for (const run of sorted) {
      // Superscripts and mixed font sizes on one line sit within a fraction of the font size.
      if (current && Math.abs(run.baseline - current.baseline) <= 0.35 * Math.max(run.size, current.size)) {
        current.runs.push(run);
        current.size = Math.max(current.size, run.size);
      } else {
        current = { page, baseline: run.baseline, size: run.size, runs: [run] };
        lines.push(current);
      }
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(line: RunLine): string {
  let out = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const run of line.runs) {
    const gap = run.x - end;
    if (out && gap > 0.18 * line.size && !out.endsWith(" ") && !run.text.startsWith(" ")) out += " ";
    out += run.text;
    end = run.x + run.width;
  }
  return out.replace(/\s+/g, " ").trim();
}

interface PdfJsPage {
  getViewport(opts: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup?(): void;
}

function collectRuns(pageIndex: number, items: unknown[], vpTransform: number[], size: PageInfo): TextRun[] {
  const runs: TextRun[] = [];
  for (const raw of items) {
    const item = raw as { str?: unknown; width?: unknown; height?: unknown; transform?: unknown };
    if (typeof item.str !== "string" || !item.str.trim() || !isMatrix(item.transform)) continue;
    const tx = multiply(vpTransform, item.transform);
    let fontSize = Math.hypot(tx[2], tx[3]);
    if (!(fontSize > 0.5)) fontSize = typeof item.height === "number" && item.height > 0.5 ? item.height : 10;
    // Only text that reads left to right on the displayed page can label a line.
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > 0.09) continue;
    const width = typeof item.width === "number" && Number.isFinite(item.width) ? Math.abs(item.width) : 0;
    const x = tx[4];
    const baseline = tx[5];
    if (!Number.isFinite(x) || !Number.isFinite(baseline)) continue;
    // Text outside the visible page (cropped away) cannot be signed against.
    if (x > size.width + 2 || x + width < -2 || baseline < -2 || baseline > size.height + fontSize) continue;
    runs.push({ page: pageIndex, text: item.str, x, baseline, width, size: Math.min(fontSize, 200) });
    if (runs.length >= MAX_RUNS_PER_PAGE) break;
  }
  return runs;
}

/** Collinear segments that overlap or touch collapse into one; double-stroked lines too. */
function mergeSegments<T extends { pos: number; a: number; b: number }>(segments: T[]): T[] {
  const sorted = segments.slice().sort((p, q) => p.pos - q.pos || p.a - q.a);
  const out: T[] = [];
  // Segments within 1.5 pt of each other across the line direction are the same line.
  let groupStart = 0;
  for (const seg of sorted) {
    while (groupStart < out.length && seg.pos - out[groupStart].pos >= 1.5) groupStart++;
    let twin: T | undefined;
    for (let i = groupStart; i < out.length; i++) {
      if (seg.a < out[i].b + 2 && seg.b > out[i].a - 2) {
        twin = out[i];
        break;
      }
    }
    if (twin) {
      twin.a = Math.min(twin.a, seg.a);
      twin.b = Math.max(twin.b, seg.b);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function collectRules(
  pageIndex: number,
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  vpTransform: number[],
  size: PageInfo,
): { rules: RuleLine[]; vrules: VerticalRule[] } {
  const horizontal: { pos: number; a: number; b: number }[] = [];
  const vertical: { pos: number; a: number; b: number }[] = [];
  interface State {
    ctm: Matrix;
    stroke: string;
    fill: string;
  }
  let state: State = { ctm: [1, 0, 0, 1, 0, 0], stroke: "#000000", fill: "#000000" };
  const stack: State[] = [];
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill]);
  const bothOps = new Set([OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const isWhite = (c: string) => /^#f{3}(f{3})?$/i.test(c);

  // A segment between two display points, kept when it is a thin horizontal or vertical line on the page.
  const addSegment = (ax: number, ay: number, bx: number, by: number) => {
    if (![ax, ay, bx, by].every(Number.isFinite)) return;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    if (y1 - y0 <= MAX_RULE_THICKNESS && x1 - x0 >= MIN_RULE_WIDTH) {
      const y = (y0 + y1) / 2;
      if (y < 0 || y > size.height) return;
      const cx0 = Math.max(0, x0);
      const cx1 = Math.min(size.width, x1);
      if (cx1 - cx0 >= MIN_RULE_WIDTH && horizontal.length < MAX_RULES_PER_PAGE * 4) horizontal.push({ pos: y, a: cx0, b: cx1 });
    } else if (x1 - x0 <= MAX_RULE_THICKNESS && y1 - y0 >= MIN_VERTICAL_LENGTH) {
      const x = (x0 + x1) / 2;
      if (x < 0 || x > size.width) return;
      const cy0 = Math.max(0, y0);
      const cy1 = Math.min(size.height, y1);
      if (cy1 - cy0 >= MIN_VERTICAL_LENGTH && vertical.length < MAX_RULES_PER_PAGE * 4) vertical.push({ pos: x, a: cy0, b: cy1 });
    }
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) {
      stack.push({ ...state });
    } else if (fn === OPS.restore) {
      state = stack.pop() ?? state;
    } else if (fn === OPS.transform) {
      if (isMatrix(args)) state = { ...state, ctm: multiply(state.ctm, args) };
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      if (args && isMatrix(args[0])) state = { ...state, ctm: multiply(state.ctm, args[0]) };
    } else if (fn === OPS.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (fn === OPS.setStrokeRGBColor) {
      if (args && typeof args[0] === "string") state = { ...state, stroke: args[0] };
    } else if (fn === OPS.setFillRGBColor) {
      if (args && typeof args[0] === "string") state = { ...state, fill: args[0] };
    } else if (fn === OPS.constructPath && args) {
      const paint = args[0] as number;
      const box = args[2];
      if (!box || typeof box !== "object") continue;
      const b = box as ArrayLike<number>;
      if (![b[0], b[1], b[2], b[3]].every(Number.isFinite)) continue;
      const stroked = strokeOps.has(paint) || bothOps.has(paint);
      let visible: boolean;
      if (strokeOps.has(paint)) visible = !isWhite(state.stroke);
      else if (fillOps.has(paint)) visible = !isWhite(state.fill);
      else if (bothOps.has(paint)) visible = !isWhite(state.stroke) || !isWhite(state.fill);
      else visible = false; // clip paths and no-op paths paint nothing
      if (!visible) continue;
      const m = multiply(vpTransform, state.ctm);
      const tx = (px: number, py: number): [number, number] => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
      const corners = [tx(b[0], b[1]), tx(b[2], b[1]), tx(b[0], b[3]), tx(b[2], b[3])];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      if (!Number.isFinite(bw + bh)) continue;
      if (bw <= MAX_RULE_THICKNESS || bh <= MAX_RULE_THICKNESS) {
        // The whole path is one thin line, drawn as a stroke or as a filled sliver.
        addSegment(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
        continue;
      }
      // A box, or a whole table drawn as one path: each straight edge is a line of its own.
      // Only outlines count; a filled area is shading, not a border.
      if (!stroked || isWhite(state.stroke)) continue;
      const data = Array.isArray(args[1]) ? (args[1] as unknown[])[0] : null;
      if (!data || typeof data !== "object" || typeof (data as ArrayLike<number>).length !== "number") continue;
      const d = data as ArrayLike<number>;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      let segments = 0;
      for (let k = 0; k < d.length && segments < MAX_SEGMENTS_PER_PATH; ) {
        const op = d[k];
        if (op === 0) {
          cur = start = tx(d[k + 1], d[k + 2]);
          k += 3;
        } else if (op === 1) {
          const next = tx(d[k + 1], d[k + 2]);
          if (cur) addSegment(cur[0], cur[1], next[0], next[1]);
          cur = next;
          segments++;
          k += 3;
        } else if (op === 2) {
          cur = tx(d[k + 5], d[k + 6]);
          k += 7;
        } else if (op === 3) {
          cur = tx(d[k + 3], d[k + 4]);
          k += 5;
        } else if (op === 4) {
          if (cur && start) addSegment(cur[0], cur[1], start[0], start[1]);
          cur = start;
          segments++;
          k += 1;
        } else {
          break; // unknown path encoding: keep what was read so far
        }
      }
    }
  }
  const rules = mergeSegments(horizontal)
    .slice(0, MAX_RULES_PER_PAGE)
    .map((s): RuleLine => ({ page: pageIndex, x0: s.a, x1: s.b, y: s.pos }));
  const vrules = mergeSegments(vertical)
    .slice(0, MAX_RULES_PER_PAGE)
    .map((s): VerticalRule => ({ page: pageIndex, x: s.pos, y0: s.a, y1: s.b }));
  return { rules, vrules };
}

/**
 * Text, page sizes and drawn lines in one pass. This is what the field detector
 * consumes; `extractText` is the same result typed as the public contract.
 */
export async function extractLayout(pdf: Uint8Array): Promise<ExtractedLayout> {
  if (!(pdf instanceof Uint8Array) || pdf.length < 8) return { ...EMPTY };
  let proxy: { numPages: number; getPage(n: number): Promise<PdfJsPage>; destroy?(): Promise<void> } | undefined;
  try {
    // pdf.js may take ownership of the buffer it is given, so hand it a copy.
    proxy = (await getDocumentProxy(pdf.slice(), { verbosity: 0 })) as unknown as typeof proxy;
    const pdfjs = (await getResolvedPDFJS()) as unknown as { OPS: Record<string, number> };
    if (!proxy) return { ...EMPTY };
    const pageCount = Math.min(proxy.numPages, LIMITS.maxPages * 2);
    const pages: PageInfo[] = [];
    const runs: TextRun[] = [];
    const rules: RuleLine[] = [];
    const vrules: VerticalRule[] = [];
    const charsPerPage: number[] = [];
    const hinted: boolean[] = [];
    const viewports: number[][] = [];

    const textStarted = Date.now();
    let unread = 0;
    for (let n = 1; n <= pageCount; n++) {
      const index = n - 1;
      let page: PdfJsPage;
      try {
        page = await proxy.getPage(n);
      } catch {
        pages.push(pages[pages.length - 1] ?? { width: 612, height: 792 });
        charsPerPage.push(0);
        hinted.push(false);
        viewports.push([1, 0, 0, -1, 0, 792]);
        continue;
      }
      const vp = page.getViewport({ scale: 1 });
      const size: PageInfo = {
        width: vp.width > 0 && Number.isFinite(vp.width) ? vp.width : 612,
        height: vp.height > 0 && Number.isFinite(vp.height) ? vp.height : 792,
      };
      pages.push(size);
      let pageRuns: TextRun[] = [];
      // The last pages are always read: that is where agreements are signed.
      if ((Date.now() - textStarted > TEXT_TIME_BUDGET_MS || runs.length > MAX_RUNS_TOTAL) && n <= pageCount - 2) {
        unread++;
      } else {
        try {
          const content = await page.getTextContent();
          pageRuns = collectRuns(index, content.items ?? [], vp.transform, size);
        } catch {
          // A page with a broken content stream is treated as having no text.
        }
      }
      for (const run of pageRuns) runs.push(run);
      const pageChars = pageRuns.reduce((sum, r) => sum + r.text.replace(/\s/g, "").length, 0);
      charsPerPage.push(pageChars);

      hinted.push(pageChars > 0 && LINE_HINT.test(pageRuns.map((r) => r.text).join(" ")));
      viewports.push(vp.transform);
      try {
        page.cleanup?.();
      } catch {
        // nothing to release
      }
    }

    const started = Date.now();
    // Drawn lines matter where a line could be a place to sign. Reading drawing
    // instructions is the slow part, so pages that talk about signing go first and
    // the end of the document (where agreements are signed) before the start; whatever
    // the time budget does not reach is still covered by the text-based rules.
    const order = pages
      .map((_, index) => index)
      .filter((index) => charsPerPage[index] > 0)
      .sort((a, b) => Number(hinted[b]) - Number(hinted[a]) || b - a);
    for (const index of order) {
      const remaining = RULES_TIME_BUDGET_MS - (Date.now() - started);
      if (remaining < 150) break;
      try {
        const page = await proxy.getPage(index + 1);
        const ops = await timeout(page.getOperatorList(), remaining);
        if (ops && Array.isArray(ops.fnArray)) {
          const found = collectRules(index, ops, pdfjs.OPS, viewports[index], pages[index]);
          for (const rule of found.rules) rules.push(rule);
          for (const rule of found.vrules) vrules.push(rule);
        }
        page.cleanup?.();
      } catch {
        // Lines are an enhancement; text-based detection still works without them.
      }
    }

    const lines = groupLines(runs);
    const pageText: string[] = pages.map(() => "");
    for (const line of lines) {
      const text = lineText(line);
      if (text) pageText[line.page] += (pageText[line.page] ? "\n" : "") + text;
    }
    const items: TextItem[] = runs.map((run) => {
      const size = pages[run.page];
      return {
        page: run.page,
        text: run.text,
        x: clamp01(run.x / size.width),
        y: clamp01((run.baseline - run.size) / size.height),
        w: clamp01(run.width / size.width),
        h: clamp01(run.size / size.height),
      };
    });
    // A scan is a document where (nearly) every page is an image. A few stray
    // characters from a fax header or page stamp do not make a page readable.
    const emptyPages = charsPerPage.filter((c) => c < 12).length;
    // Pages skipped for lack of time say nothing either way.
    const scanned = pages.length === 0 || (emptyPages - unread) / Math.max(1, pages.length - unread) >= 0.8;
    return { items, pageText, scanned, pages, runs, rules, vrules };
  } catch {
    return { ...EMPTY };
  } finally {
    try {
      await proxy?.destroy?.();
    } catch {
      // already released
    }
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Text of a PDF with positions as page fractions. Never throws. */
export async function extractText(pdf: Uint8Array): Promise<ExtractedText> {
  const { items, pageText, scanned } = await extractLayout(pdf);
  return { items, pageText, scanned };
}
