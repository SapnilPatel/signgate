/**
 * A small typesetter: HTML or plain text in, a Letter-size PDF with a real text
 * layer out. It exists because a serverless function has no browser or Word to
 * print with, and the field detector needs the text (underscore runs above all)
 * to come back out of the PDF exactly as it went in.
 *
 * It is deliberately not a browser. It lays out flowing documents (headings,
 * paragraphs, lists, simple tables, images) and ignores CSS layout.
 */
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { LIMITS } from "@/lib/types";
import { DocumentError } from "./types";
import { embedFonts, safeText, canRender, type FontSet, type FontStyle } from "./fonts";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const CONTENT_H = PAGE_H - 2 * MARGIN;
const BODY_SIZE = 11;
const LEADING = 1.4;
const TAB_STOP = 36;
const LIST_INDENT = 24;
const CELL_PAD = 4;
const MAX_DEPTH = 150;
const MAX_IMAGES = 300;
/**
 * No letter, digit or punctuation mark in the embedded fonts is narrower than about a fifth of its font size, and a line is
 * 1.4 sizes tall, so every printed character needs at least this share of size-squared of paper.
 * It turns "can this possibly fit in the page limit?" into a count, answered before any layout.
 */
const MIN_GLYPH_AREA = 0.18 * LEADING;
/**
 * A backstop, not the normal limit: a document at the page limit converts in two to three
 * seconds on a laptop, and the page-limit checks stop oversized input long before this.
 */
const TYPESET_BUDGET_MS = 12_000;
/** PNG pictures inside a document are decoded in memory at roughly 16 bytes per pixel and a tenth of a second per million pixels. */
const MAX_PNG_PIXELS_EACH = 25_000_000;
const MAX_PNG_PIXELS_TOTAL = 60_000_000;
const INK = rgb(0.1, 0.1, 0.1);
const GRID = rgb(0.72, 0.72, 0.72);
const FOOTER = rgb(0.45, 0.45, 0.45);

export interface TypesetOptions {
  /** Stored as the PDF's metadata title; never printed on the page. */
  title?: string;
  /** Keep tab characters as tab stops instead of collapsing them like HTML whitespace.
   *  Word output needs this: tabs position signature blocks. */
  preserveTabs?: boolean;
  /** Render an empty <p> as a blank line (Word uses empty paragraphs as spacing). */
  keepEmptyParagraphs?: boolean;
  maxPages?: number;
}

export interface TypesetResult {
  pdf: Uint8Array;
  pageCount: number;
  /** False when nothing visible was drawn (no text and no usable image). */
  hasContent: boolean;
  /** Images that were referenced but could not be embedded (remote, or an unsupported format). */
  skippedImages: number;
  /** True when some characters are not covered by the embedded font and were replaced. */
  replacedCharacters: boolean;
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
}

type Inline =
  | { t: "text"; text: string; st: Style }
  | { t: "br" }
  | { t: "img"; key: string; w?: number; h?: number };

interface BlockCtx {
  indent: number;
  align: "left" | "center" | "right";
  pre: boolean;
  spaceBefore: number;
  spaceAfter: number;
  keep: boolean;
}

interface Para extends BlockCtx {
  k: "para";
  inlines: Inline[];
  marker?: string;
  size: number;
}

interface TableCell {
  col: number;
  span: number;
  blocks: Block[];
}

interface Table {
  k: "table";
  indent: number;
  cols: number;
  rows: TableCell[][];
}

type Block = Para | Table | { k: "break" } | { k: "rule"; indent: number };

interface Box {
  k: "box";
  h: number;
  keep?: boolean;
  draw(page: PDFPage, left: number, top: number): void;
}

interface LaidTable {
  k: "table";
  x: number;
  cols: number[];
  rows: { col: number; span: number; boxes: Box[] }[][];
}

type Item = Box | { k: "space"; h: number } | { k: "break" } | LaidTable;

interface Env {
  /** Epoch milliseconds after which conversion stops with an error the uploader can act on. */
  deadline: number;
  maxPages: number;
  fonts: FontSet;
  images: Map<string, { image: PDFImage; w: number; h: number } | null>;
  rawImages: Map<string, Uint8Array | null>;
  options: TypesetOptions;
  replaced: boolean;
  skippedImages: number;
  drew: boolean;
}

const DEFAULT_STYLE: Style = { bold: false, italic: false, underline: false, strike: false, size: BODY_SIZE };
const DEFAULT_CTX: BlockCtx = { indent: 0, align: "left", pre: false, spaceBefore: 0, spaceAfter: 6, keep: false };

function fontFor(env: Env, st: Style): PDFFont {
  const key: FontStyle = st.bold ? (st.italic ? "boldItalic" : "bold") : st.italic ? "italic" : "regular";
  return env.fonts[key];
}

const sameStyle = (a: Style, b: Style) =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.size === b.size;

// ---------------------------------------------------------------------------
// HTML -> blocks
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  "script", "style", "head", "title", "meta", "link", "noscript", "template", "svg", "math", "iframe", "object",
  "embed", "video", "audio", "canvas", "map", "button", "datalist", "option", "optgroup",
]);

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "address", "figure", "figcaption",
  "form", "fieldset", "legend", "details", "summary", "dl", "dt", "dd", "blockquote", "pre", "center", "body", "html",
  "tr", "td", "th", "thead", "tbody", "tfoot", "caption", "h1", "h2", "h3", "h4", "h5", "h6",
]);

const HEADINGS: Record<string, { size: number; before: number; after: number }> = {
  h1: { size: 18, before: 14, after: 8 },
  h2: { size: 15, before: 12, after: 6 },
  h3: { size: 13, before: 10, after: 5 },
  h4: { size: 11.5, before: 8, after: 4 },
  h5: { size: 11, before: 8, after: 4 },
  h6: { size: 11, before: 8, after: 4 },
};

class Builder {
  blocks: Block[] = [];
  private cur: Inline[] = [];
  private curCtx: BlockCtx = DEFAULT_CTX;
  private curSize = BODY_SIZE;
  /** True when the next leading whitespace would be collapsed away. */
  private atBoundary = true;
  marker: string | undefined;

  add(inline: Inline, ctx: BlockCtx, size: number) {
    if (this.cur.length === 0) {
      this.curCtx = ctx;
      this.curSize = size;
    }
    this.cur.push(inline);
  }

  text(raw: string, ctx: BlockCtx, st: Style, env: Env) {
    let text = raw.replace(/\r\n?/g, "\n").replace(/\u00ad/g, "");
    if (st.underline) {
      // Word documents draw signature lines as underlined tabs or spaces. Underlined
      // blank space has no glyphs, so it would vanish from the text layer; turning it
      // into underscores keeps the line visible and detectable.
      const before = text;
      text = text.replace(/\t+|[ \u00a0]{3,}/g, (run) =>
        run[0] === "\t" ? "________".repeat(run.length) : "_".repeat(Math.max(3, Math.ceil(run.length / 2))),
      );
      if (text !== before && /^_+$/.test(text)) st = { ...st, underline: false };
    }
    if (!ctx.pre) {
      text = env.options.preserveTabs ? text.replace(/[ \n\f]+/g, " ") : text.replace(/[ \n\f\t]+/g, " ");
      if (this.atBoundary) text = text.replace(/^ +/, "");
      if (!text) return;
      this.atBoundary = text.endsWith(" ");
    }
    if (!text) return;
    this.add({ t: "text", text, st }, ctx, st.size);
  }

  lineBreak(ctx: BlockCtx, size: number) {
    this.add({ t: "br" }, ctx, size);
    this.atBoundary = true;
  }

  image(key: string, ctx: BlockCtx, size: number, w?: number, h?: number) {
    this.add({ t: "img", key, w, h }, ctx, size);
    this.atBoundary = false;
  }

  /** Ends the current paragraph. Returns true when a paragraph was emitted. */
  flush(): boolean {
    const inlines = this.cur;
    this.cur = [];
    this.atBoundary = true;
    const visible = inlines.some((i) => i.t === "img" || i.t === "br" || (i.t === "text" && /[^\s]/.test(i.text)));
    if (!visible) return false;
    // A single trailing <br> before a block boundary does not add a line in a browser.
    if (inlines.length > 1 && inlines[inlines.length - 1].t === "br") inlines.pop();
    this.blocks.push({ k: "para", inlines, ...this.curCtx, marker: this.takeMarker(), size: this.curSize });
    return true;
  }

  blank(ctx: BlockCtx, size: number) {
    this.blocks.push({ k: "para", inlines: [], ...ctx, marker: this.takeMarker(), size });
  }

  private takeMarker() {
    const m = this.marker;
    this.marker = undefined;
    return m;
  }
}

function parseCss(el: HTMLElement): Record<string, string> {
  const raw = el.getAttribute("style");
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim().toLowerCase();
  }
  return out;
}

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

function toAlpha(n: number): string {
  if (n <= 0) return String(n);
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function orderedMarker(n: number, kind: string): string {
  switch (kind) {
    case "a": return `${toAlpha(n)}.`;
    case "A": return `${toAlpha(n).toUpperCase()}.`;
    case "i": return `${toRoman(n)}.`;
    case "I": return `${toRoman(n).toUpperCase()}.`;
    default: return `${n}.`;
  }
}

function decodeDataUri(src: string): Uint8Array | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(src.slice(0, 200));
  if (!m) return null;
  const body = src.slice(m[0].length);
  try {
    if (/;base64/i.test(m[2])) return new Uint8Array(Buffer.from(body.replace(/\s+/g, ""), "base64"));
    return new Uint8Array(Buffer.from(decodeURIComponent(body), "latin1"));
  } catch {
    return null;
  }
}

/** Text of a subtree, gathered without recursion so depth cannot overflow the stack. */
function elementText(el: Node): string {
  const parts: string[] = [];
  const stack: Node[] = [el];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === NodeType.TEXT_NODE) parts.push(node.text);
    else if (node.nodeType === NodeType.ELEMENT_NODE && !SKIP_TAGS.has(tagOf(node))) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
  }
  return parts.join(" ");
}

interface WalkState {
  env: Env;
  /** Nesting depth of ordered lists, used to vary numbering like Word does. */
  olDepth: number;
  ulDepth: number;
}

function tagOf(node: Node): string {
  return ((node as HTMLElement).rawTagName ?? "").toLowerCase();
}

function walkChildren(el: Node, b: Builder, ctx: BlockCtx, st: Style, ws: WalkState, depth: number) {
  for (const child of el.childNodes) walk(child, b, ctx, st, ws, depth + 1);
}

function walk(node: Node, b: Builder, ctx: BlockCtx, st: Style, ws: WalkState, depth: number) {
  if (node.nodeType === NodeType.TEXT_NODE) {
    b.text(node.text, ctx, st, ws.env);
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return;
  if (depth > MAX_DEPTH) {
    // Pathologically nested markup: keep the words, stop recursing.
    b.text(elementText(el), ctx, st, ws.env);
    return;
  }

  const css = parseCss(el);
  if (css.display === "none" || css.visibility === "hidden" || el.hasAttribute("hidden")) return;

  const weight = css["font-weight"];
  if (weight) st = { ...st, bold: weight === "bold" || weight === "bolder" || Number(weight) >= 600 };
  if (css["font-style"]) st = { ...st, italic: /italic|oblique/.test(css["font-style"]) };
  const deco = css["text-decoration"] ?? css["text-decoration-line"];
  if (deco) st = { ...st, underline: st.underline || deco.includes("underline"), strike: st.strike || deco.includes("line-through") };
  const alignRaw = css["text-align"] ?? (tag === "center" ? "center" : el.getAttribute("align")?.toLowerCase());
  if (alignRaw === "center" || alignRaw === "right" || alignRaw === "left") ctx = { ...ctx, align: alignRaw };
  else if (alignRaw === "justify" || alignRaw === "start") ctx = { ...ctx, align: "left" };

  const breakBefore = /always|page/.test(css["page-break-before"] ?? css["break-before"] ?? "");
  const breakAfter = /always|page/.test(css["page-break-after"] ?? css["break-after"] ?? "");
  if (breakBefore) {
    b.flush();
    b.blocks.push({ k: "break" });
  }

  switch (tag) {
    case "br":
      b.lineBreak(ctx, st.size);
      break;
    case "hr":
      b.flush();
      b.blocks.push(/page-?break/i.test(el.getAttribute("class") ?? "") ? { k: "break" } : { k: "rule", indent: ctx.indent });
      break;
    case "img": {
      const src = el.getAttribute("src") ?? "";
      const env = ws.env;
      if (!env.rawImages.has(src)) {
        // Only inline data is used. Fetching a URL named by an uploaded document
        // would let the document make the server call arbitrary addresses.
        env.rawImages.set(src, env.rawImages.size < MAX_IMAGES ? decodeDataUri(src) : null);
      }
      const w = Number.parseFloat(el.getAttribute("width") ?? "");
      const h = Number.parseFloat(el.getAttribute("height") ?? "");
      b.image(src, ctx, st.size, Number.isFinite(w) && w > 0 ? w * 0.75 : undefined, Number.isFinite(h) && h > 0 ? h * 0.75 : undefined);
      break;
    }
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "file" || type === "image") break;
      if (type === "checkbox" || type === "radio") b.text("[  ] ", { ...ctx, pre: true }, st, ws.env);
      else b.text("____________________", ctx, st, ws.env);
      break;
    }
    case "textarea":
    case "select":
      b.text("____________________", ctx, st, ws.env);
      break;
    case "b":
    case "strong":
      walkChildren(el, b, ctx, { ...st, bold: true }, ws, depth);
      break;
    case "i":
    case "em":
    case "cite":
    case "var":
    case "dfn":
      walkChildren(el, b, ctx, { ...st, italic: true }, ws, depth);
      break;
    case "u":
    case "ins":
      walkChildren(el, b, ctx, { ...st, underline: true }, ws, depth);
      break;
    case "s":
    case "strike":
    case "del":
      walkChildren(el, b, ctx, { ...st, strike: true }, ws, depth);
      break;
    case "ul":
    case "ol":
    case "menu":
      walkList(el, tag === "ol", b, ctx, st, ws, depth);
      break;
    case "li":
      // A list item with no list around it.
      walkItem(el, "\u2022", b, { ...ctx, indent: ctx.indent + LIST_INDENT }, st, ws, depth);
      break;
    case "table":
      walkTable(el, b, ctx, st, ws, depth);
      break;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const h = HEADINGS[tag];
      b.flush();
      walkChildren(el, b, { ...ctx, spaceBefore: h.before, spaceAfter: h.after, keep: true }, { ...st, bold: true, size: h.size }, ws, depth);
      b.flush();
      break;
    }
    case "p": {
      b.flush();
      const before = b.blocks.length;
      walkChildren(el, b, ctx, st, ws, depth);
      b.flush();
      if (b.blocks.length === before && ws.env.options.keepEmptyParagraphs) b.blank(ctx, st.size);
      break;
    }
    case "blockquote":
    case "dd":
      b.flush();
      walkChildren(el, b, { ...ctx, indent: ctx.indent + LIST_INDENT }, st, ws, depth);
      b.flush();
      break;
    case "dt":
    case "th":
    case "caption":
    case "legend":
      b.flush();
      walkChildren(el, b, ctx, { ...st, bold: true }, ws, depth);
      b.flush();
      break;
    case "pre":
      b.flush();
      walkChildren(el, b, { ...ctx, pre: true }, st, ws, depth);
      b.flush();
      break;
    default:
      if (BLOCK_TAGS.has(tag)) {
        b.flush();
        walkChildren(el, b, ctx, st, ws, depth);
        b.flush();
      } else {
        walkChildren(el, b, ctx, st, ws, depth);
      }
  }

  if (breakAfter) {
    b.flush();
    b.blocks.push({ k: "break" });
  }
}

function walkList(el: HTMLElement, ordered: boolean, b: Builder, ctx: BlockCtx, st: Style, ws: WalkState, depth: number) {
  b.flush();
  const inner: WalkState = { ...ws, olDepth: ws.olDepth + (ordered ? 1 : 0), ulDepth: ws.ulDepth + (ordered ? 0 : 1) };
  const itemCtx = { ...ctx, indent: ctx.indent + LIST_INDENT, spaceBefore: 0, spaceAfter: 3 };
  const typeAttr = el.getAttribute("type") ?? "";
  const kind = /^[aAiI1]$/.test(typeAttr) ? typeAttr : ["1", "a", "i"][(inner.olDepth - 1) % 3];
  const bullets = ["\u2022", "\u25e6", "\u25aa"];
  const bullet = bullets[(inner.ulDepth - 1 + bullets.length) % bullets.length];
  const start = Number.parseInt(el.getAttribute("start") ?? "", 10);
  let n = Number.isFinite(start) ? start : 1;
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE && tagOf(child) === "li") {
      const value = Number.parseInt((child as HTMLElement).getAttribute("value") ?? "", 10);
      if (ordered && Number.isFinite(value)) n = value;
      walkItem(child as HTMLElement, ordered ? orderedMarker(n, kind) : bullet, b, itemCtx, st, inner, depth + 1);
      n += 1;
    } else {
      // Nested lists written directly inside a list (invalid but common) and stray text.
      walk(child, b, itemCtx, st, inner, depth + 1);
    }
  }
  b.flush();
}

function walkItem(el: HTMLElement, marker: string, b: Builder, ctx: BlockCtx, st: Style, ws: WalkState, depth: number) {
  b.flush();
  b.marker = marker;
  walkChildren(el, b, ctx, st, ws, depth);
  b.flush();
  // An item whose first content was not a paragraph (or that was empty) still shows its marker.
  if (b.marker !== undefined) {
    const last = b.blocks[b.blocks.length - 1];
    b.marker = undefined;
    if (!last || last.k !== "para" || last.marker !== marker) {
      b.blocks.push({ k: "para", inlines: [], ...ctx, marker, size: st.size });
    }
  }
}

function tableRows(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of table.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const tag = tagOf(child);
    if (tag === "tr") rows.push(child as HTMLElement);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const inner of child.childNodes) {
        if (inner.nodeType === NodeType.ELEMENT_NODE && tagOf(inner) === "tr") rows.push(inner as HTMLElement);
      }
    }
  }
  return rows;
}

function walkTable(el: HTMLElement, b: Builder, ctx: BlockCtx, st: Style, ws: WalkState, depth: number) {
  b.flush();
  // Captions and any stray content come first, as ordinary blocks.
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE && tagOf(child) === "caption") walk(child, b, ctx, st, ws, depth + 1);
  }
  const trs = tableRows(el);
  const rows: TableCell[][] = [];
  const taken: boolean[][] = [];
  let cols = 0;
  trs.forEach((tr, r) => {
    const row: TableCell[] = [];
    let col = 0;
    for (const cellNode of tr.childNodes) {
      if (cellNode.nodeType !== NodeType.ELEMENT_NODE) continue;
      const tag = tagOf(cellNode);
      if (tag !== "td" && tag !== "th") continue;
      const cell = cellNode as HTMLElement;
      while (taken[r]?.[col]) col += 1;
      const span = Math.min(50, Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1));
      const rowspan = Math.min(500, Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1));
      for (let rr = r + 1; rr < r + rowspan && rr < trs.length; rr++) {
        taken[rr] ??= [];
        for (let cc = col; cc < col + span; cc++) taken[rr][cc] = true;
      }
      const sub = new Builder();
      const cellCtx: BlockCtx = { ...DEFAULT_CTX, spaceAfter: 3, align: ctx.align };
      // Run through walk() itself so the cell's own alignment and styles apply.
      walk(cell, sub, cellCtx, tag === "th" ? { ...st, bold: true } : st, ws, depth + 2);
      sub.flush();
      row.push({ col, span, blocks: sub.blocks });
      col += span;
      cols = Math.max(cols, col);
    }
    rows.push(row);
  });

  if (cols === 0) {
    walkChildren(el, b, ctx, st, ws, depth);
    b.flush();
    return;
  }
  b.blocks.push({ k: "table", indent: ctx.indent, cols, rows });
}

function htmlToBlocks(html: string, env: Env): Block[] {
  const root = parse(html, {
    comment: false,
    // <pre> is left out on purpose so its markup is parsed like any other element.
    blockTextElements: { script: true, style: true, noscript: true },
  });
  const b = new Builder();
  walk(root, b, DEFAULT_CTX, DEFAULT_STYLE, { env, olDepth: 0, ulDepth: 0 }, 0);
  b.flush();
  return b.blocks;
}

function textToBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const ctx: BlockCtx = { ...DEFAULT_CTX, pre: true, spaceAfter: 0 };
  const pages = text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029\u0085\v]/g, "\n").split("\f");
  pages.forEach((pageText, p) => {
    if (p > 0) blocks.push({ k: "break" });
    // Blank lines separate paragraphs; extra blank lines are kept (up to a point)
    // because people space out signature blocks with them.
    const parts = pageText.split(/(\n(?:[ \t]*\n)+)/);
    for (let i = 0; i < parts.length; i += 2) {
      const body = parts[i].replace(/^\n+|\n+$/g, "");
      if (/[^\s]/.test(body)) {
        const inlines: Inline[] = [];
        body.split("\n").forEach((line, n) => {
          if (n > 0) inlines.push({ t: "br" });
          const trimmed = line.replace(/[ \t]+$/, "");
          if (trimmed) inlines.push({ t: "text", text: trimmed, st: DEFAULT_STYLE });
        });
        blocks.push({ k: "para", inlines, ...ctx, size: BODY_SIZE });
      }
      const gap = parts[i + 1];
      if (gap !== undefined && blocks.length > 0) {
        const blankLines = Math.min(4, gap.split("\n").length - 2);
        for (let n = 0; n < blankLines; n++) blocks.push({ k: "para", inlines: [], ...ctx, size: BODY_SIZE });
      }
    }
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Seg =
  | { kind: "text"; x: number; w: number; text: string; st: Style }
  | { kind: "img"; x: number; w: number; h: number; image: PDFImage };

interface Line {
  segs: Seg[];
  w: number;
  size: number;
  imgH: number;
}

const widthCache = new WeakMap<PDFFont, Map<string, number>>();
const WIDTH_CACHE_ENTRIES = 60_000;

/**
 * Width of a word. Shaping a string is the single most expensive step of conversion and
 * agreements repeat the same words thousands of times, so each word is shaped once per font;
 * width scales linearly with size.
 */
function measure(font: PDFFont, text: string, size: number): number {
  if (text.length > 48) return font.widthOfTextAtSize(text, size);
  let cache = widthCache.get(font);
  if (!cache) {
    cache = new Map();
    widthCache.set(font, cache);
  }
  let unit = cache.get(text);
  if (unit === undefined) {
    unit = font.widthOfTextAtSize(text, 1000);
    if (cache.size >= WIDTH_CACHE_ENTRIES) cache.clear();
    cache.set(text, unit);
  }
  return (unit * size) / 1000;
}

function widthOf(env: Env, st: Style, text: string): number {
  return measure(fontFor(env, st), text, st.size);
}

function tooManyPages(maxPages: number): DocumentError {
  return new DocumentError(
    "too_many_pages",
    `This document is longer than ${maxPages} pages, which is the most an agreement can have here. Shorten it or split it, then upload again.`,
  );
}

function checkDeadline(env: Env): void {
  if (Date.now() > env.deadline) {
    throw new DocumentError("too_large", "This document is too large to convert here. Save or export it as a PDF and upload that instead.");
  }
}

function inkCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c !== 0xa0) n++;
  }
  return n;
}

/** Paper the text needs at the very least, in square points. */
function minimumArea(blocks: Block[]): number {
  let area = 0;
  for (const block of blocks) {
    if (block.k === "para") {
      for (const inline of block.inlines) if (inline.t === "text") area += inkCount(inline.text) * inline.st.size * inline.st.size * MIN_GLYPH_AREA;
    } else if (block.k === "table") {
      for (const row of block.rows) for (const cell of row) area += minimumArea(cell.blocks);
    }
  }
  return area;
}

function layoutPara(p: Para, width: number, env: Env): Item[] {
  const avail = Math.max(60, width - p.indent);
  const lines: Line[] = [];
  let line: Line = { segs: [], w: 0, size: 0, imgH: 0 };
  /** True right after an automatic wrap, where leading spaces are dropped. */
  let wrapped = false;
  let lastSize = p.size;
  let laidHeight = 0;

  const finish = (soft: boolean) => {
    const last = line.segs[line.segs.length - 1];
    if (last && last.kind === "text" && soft) {
      const trimmed = last.text.replace(/ +$/, "");
      if (trimmed !== last.text) {
        line.w -= last.w;
        // Taking off the width of the spaces themselves avoids shaping the whole line a second time.
        last.w = trimmed ? Math.max(0, last.w - widthOf(env, last.st, last.text.slice(trimmed.length))) : 0;
        last.text = trimmed;
        line.w += last.w;
        if (!trimmed) line.segs.pop();
      }
    }
    if (line.size === 0) line.size = lastSize;
    lines.push(line);
    // One paragraph can be the whole upload (a text file with no blank lines). Stop as soon as it
    // alone is past the page limit, rather than breaking megabytes into lines that are then refused.
    laidHeight += Math.max(line.size * LEADING, line.imgH);
    if (laidHeight > (env.maxPages + 1) * CONTENT_H) throw tooManyPages(env.maxPages);
    if ((lines.length & 63) === 0) checkDeadline(env);
    line = { segs: [], w: 0, size: 0, imgH: 0 };
    wrapped = soft;
  };

  const put = (text: string, w: number, st: Style) => {
    const last = line.segs[line.segs.length - 1];
    if (last && last.kind === "text" && sameStyle(last.st, st) && Math.abs(last.x + last.w - line.w) < 0.01) {
      last.text += text;
      last.w += w;
    } else {
      line.segs.push({ kind: "text", x: line.w, w, text, st });
    }
    line.w += w;
    line.size = Math.max(line.size, st.size);
    lastSize = st.size;
  };

  const word = (text: string, st: Style) => {
    const w = widthOf(env, st, text);
    if (line.w + w <= avail + 0.01) return put(text, w, st);
    if (w <= avail) {
      finish(true);
      return put(text, w, st);
    }
    // Longer than a whole line (a URL, or a very long underscore rule): break between characters.
    let piece = "";
    let pieceW = 0;
    for (const ch of text) {
      const cw = widthOf(env, st, ch);
      if (line.w + pieceW + cw > avail + 0.01 && (piece || line.w > 0)) {
        if (piece) put(piece, pieceW, st);
        finish(true);
        piece = "";
        pieceW = 0;
      }
      piece += ch;
      pieceW += cw;
    }
    if (piece) put(piece, pieceW, st);
  };

  for (const inline of p.inlines) {
    if (inline.t === "br") {
      finish(false);
      continue;
    }
    if (inline.t === "img") {
      const entry = env.images.get(inline.key);
      if (!entry) continue;
      let w = inline.w ?? (inline.h ? (entry.w * inline.h) / entry.h : entry.w);
      let h = inline.h ?? (inline.w ? (entry.h * inline.w) / entry.w : entry.h);
      // Never wider than the column or taller than most of a page, keeping the proportions.
      const scale = Math.min(1, avail / w, (CONTENT_H * 0.85) / h);
      w *= scale;
      h *= scale;
      if (line.w > 0 && line.w + w > avail + 0.01) finish(true);
      line.segs.push({ kind: "img", x: line.w, w, h, image: entry.image });
      line.w += w;
      line.imgH = Math.max(line.imgH, h);
      wrapped = false;
      continue;
    }
    const st = inline.st;
    const font = fontFor(env, st);
    if (!env.replaced && !canRender(font, inline.text)) env.replaced = true;
    for (const tok of inline.text.match(/\n|\t|[ ]+|[^\n\t ]+/g) ?? []) {
      if (tok === "\n") {
        finish(false);
      } else if (tok === "\t") {
        const next = (Math.floor((line.w + 0.5) / TAB_STOP) + 1) * TAB_STOP;
        if (next > avail) finish(true);
        else {
          line.w = next;
          if (line.size === 0) line.size = st.size;
        }
      } else if (tok[0] === " ") {
        if (line.w === 0 && (wrapped || !p.pre)) continue;
        const text = p.pre ? tok : " ";
        const w = widthOf(env, st, text);
        if (line.w + w > avail) finish(true);
        else put(text, w, st);
      } else {
        const safe = safeText(font, tok);
        if (safe) {
          word(safe, st);
          wrapped = false;
        }
      }
    }
  }
  if (line.segs.length > 0 || line.w > 0 || lines.length === 0) finish(true);

  const items: Item[] = [];
  if (p.spaceBefore > 0) items.push({ k: "space", h: p.spaceBefore });
  lines.forEach((ln, index) => {
    const textH = ln.size * LEADING;
    const h = Math.max(textH, ln.imgH > 0 ? ln.imgH + ln.size * 0.5 : 0);
    const offset = p.align === "center" ? (avail - ln.w) / 2 : p.align === "right" ? avail - ln.w : 0;
    const marker = index === 0 ? p.marker : undefined;
    const visible = ln.segs.length > 0 || Boolean(marker);
    items.push({
      k: "box",
      h,
      keep: p.keep,
      draw: (page, left, top) => {
        const baseline = top - h + ln.size * 0.35;
        const x0 = left + p.indent + Math.max(0, offset);
        if (marker) {
          const st: Style = { ...DEFAULT_STYLE, size: p.size };
          const font = fontFor(env, st);
          const text = canRender(font, marker) ? marker : "-";
          const mw = measure(font, text, st.size);
          page.drawText(text, { x: left + p.indent - 6 - mw, y: baseline, size: st.size, font, color: INK });
        }
        for (const seg of ln.segs) {
          if (seg.kind === "img") {
            page.drawImage(seg.image, { x: x0 + seg.x, y: baseline, width: seg.w, height: seg.h });
            continue;
          }
          if (!seg.text) continue;
          const font = fontFor(env, seg.st);
          page.drawText(seg.text, { x: x0 + seg.x, y: baseline, size: seg.st.size, font, color: INK });
          const thickness = Math.max(0.5, seg.st.size * 0.055);
          if (seg.st.underline) {
            const y = baseline - seg.st.size * 0.13;
            page.drawLine({ start: { x: x0 + seg.x, y }, end: { x: x0 + seg.x + seg.w, y }, thickness, color: INK });
          }
          if (seg.st.strike) {
            const y = baseline + seg.st.size * 0.28;
            page.drawLine({ start: { x: x0 + seg.x, y }, end: { x: x0 + seg.x + seg.w, y }, thickness, color: INK });
          }
        }
        if (visible) env.drew = true;
      },
    });
  });
  if (p.spaceAfter > 0) items.push({ k: "space", h: p.spaceAfter });
  return items;
}

/** Width a cell would like if it never had to wrap, used to share out column widths. */
function naturalWidth(blocks: Block[], env: Env): number {
  let max = 0;
  for (const block of blocks) {
    if (block.k === "table") {
      for (const row of block.rows) for (const cell of row) max = Math.max(max, naturalWidth(cell.blocks, env));
      continue;
    }
    if (block.k !== "para") continue;
    let run = block.indent;
    for (const inline of block.inlines) {
      if (inline.t === "br") {
        max = Math.max(max, run);
        run = block.indent;
      } else if (inline.t === "img") {
        run += inline.w ?? env.images.get(inline.key)?.w ?? 0;
      } else {
        for (const part of inline.text.split("\n")) {
          // Only "does it exceed the column?" matters, and a few hundred characters always do.
          run += widthOf(env, inline.st, safeText(fontFor(env, inline.st), part.slice(0, 400)));
          if (run > CONTENT_W) break;
        }
      }
    }
    max = Math.max(max, run);
    if (max > CONTENT_W) return CONTENT_W;
  }
  return max;
}

/** Collapses spacing so a list of items becomes plain boxes (used inside table cells). */
function toBoxes(items: Item[]): Box[] {
  const out: Box[] = [];
  let gap = 0;
  for (const item of items) {
    if (item.k === "space") gap = Math.max(gap, item.h);
    else if (item.k === "box") {
      if (gap > 0 && out.length > 0) out.push({ k: "box", h: gap, draw: () => {} });
      gap = 0;
      out.push(item);
    }
  }
  return out;
}

/** Table content laid out one cell after another, for tables too dense to draw as a grid. */
function flattenTable(table: Table): Block[] {
  const out: Block[] = [];
  for (const row of table.rows) {
    for (const cell of row) {
      for (const block of cell.blocks) {
        if (block.k === "table") out.push(...flattenTable(block));
        else if (block.k === "para") out.push({ ...block, indent: block.indent + table.indent });
        else out.push(block);
      }
    }
  }
  return out;
}

function layoutTable(table: Table, width: number, env: Env): Item[] {
  const total = width - table.indent;
  const minCol = 42;
  if (table.cols * minCol > total) {
    return flattenTable(table).flatMap((block) => layoutBlock(block, width, env, true));
  }
  const natural = new Array<number>(table.cols).fill(minCol);
  for (const row of table.rows) {
    for (const cell of row) {
      if (cell.span !== 1) continue;
      natural[cell.col] = Math.max(natural[cell.col], naturalWidth(cell.blocks, env) + 2 * CELL_PAD + 1);
    }
  }
  // Columns that fit keep the width they want, so short cells (amounts, labels)
  // never wrap; the columns with long text share what is left.
  const sum = natural.reduce((a, n) => a + n, 0);
  let cols: number[];
  if (sum <= total) {
    cols = natural.map((n) => (n / sum) * total);
  } else {
    const fair = total / table.cols;
    const fixed = natural.map((n) => n <= fair);
    const fixedSum = natural.reduce((a, n, i) => a + (fixed[i] ? n : 0), 0);
    const flexSum = sum - fixedSum;
    cols = natural.map((n, i) => (fixed[i] ? n : (n / flexSum) * (total - fixedSum)));
  }
  if (cols.some((c) => !(c >= minCol - 0.01))) cols = natural.map(() => total / table.cols);

  const rows = table.rows.map((row) =>
    row
      .filter((cell) => cell.col < table.cols)
      .map((cell) => {
        const span = Math.min(cell.span, table.cols - cell.col);
        const w = cols.slice(cell.col, cell.col + span).reduce((a, c) => a + c, 0) - 2 * CELL_PAD;
        const boxes = toBoxes(cell.blocks.flatMap((block) => layoutBlock(block, w, env, true)));
        return { col: cell.col, span, boxes };
      }),
  );
  return [{ k: "space", h: 4 }, { k: "table", x: table.indent, cols, rows }, { k: "space", h: 8 }];
}

function layoutBlock(block: Block, width: number, env: Env, insideCell = false): Item[] {
  switch (block.k) {
    case "para":
      return layoutPara(block, width, env);
    case "break":
      return insideCell ? [] : [{ k: "break" }];
    case "rule":
      return [
        {
          k: "box",
          h: 12,
          draw: (page, left, top) => {
            page.drawLine({
              start: { x: left + block.indent, y: top - 6 },
              end: { x: left + width, y: top - 6 },
              thickness: 0.6,
              color: GRID,
            });
          },
        },
      ];
    case "table":
      // A table inside a table cell is read as running text; nested grids are beyond "simple tables".
      if (insideCell) return flattenTable(block).flatMap((inner) => layoutBlock(inner, width, env, true));
      return layoutTable(block, width, env);
  }
}

class Flow {
  readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private atTop = true;
  private gap = 0;

  constructor(private doc: PDFDocument, private maxPages: number) {
    this.newPage();
  }

  private newPage() {
    if (this.pages.length >= this.maxPages) throw tooManyPages(this.maxPages);
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
    this.atTop = true;
    this.gap = 0;
  }

  private get room() {
    return this.y - MARGIN;
  }

  run(items: Item[]) {
    for (const item of items) {
      if (item.k === "space") this.gap = Math.max(this.gap, item.h);
      else if (item.k === "break") {
        if (!this.atTop) this.newPage();
      } else if (item.k === "box") this.box(item);
      else this.table(item);
    }
  }

  private box(box: Box) {
    if (!this.atTop) {
      // A heading must not be the last thing on a page.
      const need = this.gap + box.h + (box.keep ? BODY_SIZE * LEADING * 2 : 0);
      if (need > this.room) this.newPage();
      else this.y -= this.gap;
    }
    this.gap = 0;
    box.draw(this.page, MARGIN, this.y);
    this.y -= box.h;
    this.atTop = false;
  }

  private table(table: LaidTable) {
    const x0 = MARGIN + table.x;
    const colX: number[] = [];
    table.cols.reduce((x, w, i) => ((colX[i] = x), x + w), x0);
    const emptyRow = BODY_SIZE * LEADING;

    for (const row of table.rows) {
      if (row.length === 0) continue;
      const done = row.map(() => 0);
      const total = Math.max(...row.map((c) => c.boxes.reduce((a, bx) => a + bx.h, 0)), emptyRow) + 2 * CELL_PAD;
      let first = true;
      for (;;) {
        const remaining = row.some((c, i) => done[i] < c.boxes.length);
        if (!remaining && !first) break;
        if (!this.atTop) {
          // Keep a row in one piece when it fits on a page at all.
          const fitsWhole = this.gap + total <= this.room;
          if (!fitsWhole && first && total <= CONTENT_H) {
            this.newPage();
          } else {
            this.y -= Math.min(this.gap, Math.max(0, this.room));
          }
        }
        this.gap = 0;
        const avail = this.room - 2 * CELL_PAD;
        const take = row.map((c, i) => {
          let n = done[i];
          let h = 0;
          while (n < c.boxes.length && h + c.boxes[n].h <= avail + 0.01) {
            h += c.boxes[n].h;
            n += 1;
          }
          return { n, h };
        });
        const progressed = take.some((t, i) => t.n > done[i]);
        if (remaining && !progressed) {
          if (!this.atTop) {
            this.newPage();
            continue;
          }
          // Nothing fits even on an empty page: place one box anyway so layout always advances.
          row.forEach((c, i) => {
            if (done[i] < c.boxes.length) take[i] = { n: done[i] + 1, h: c.boxes[done[i]].h };
          });
        }
        const portion = Math.max(...take.map((t) => t.h), remaining ? 0 : emptyRow) + 2 * CELL_PAD;
        row.forEach((cell, i) => {
          const cx = colX[cell.col];
          const cw = table.cols.slice(cell.col, cell.col + cell.span).reduce((a, c) => a + c, 0);
          this.page.drawRectangle({ x: cx, y: this.y - portion, width: cw, height: portion, borderColor: GRID, borderWidth: 0.5 });
          let top = this.y - CELL_PAD;
          for (let n = done[i]; n < take[i].n; n++) {
            cell.boxes[n].draw(this.page, cx + CELL_PAD, top);
            top -= cell.boxes[n].h;
          }
          done[i] = take[i].n;
        });
        this.y -= portion;
        this.atTop = false;
        first = false;
        if (row.some((c, i) => done[i] < c.boxes.length)) this.newPage();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function isPng(b: Uint8Array) {
  return b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isJpeg(b: Uint8Array) {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** Width times height from a PNG header, or 0 when the header is not where it should be. */
function pngPixels(b: Uint8Array): number {
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return 0;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

async function embedImages(doc: PDFDocument, env: Env) {
  // PNGs are decoded to raw pixels in memory; pictures beyond the budget are left out and reported
  // as skipped rather than letting one oversized screenshot take the whole upload down.
  let pngBudget = MAX_PNG_PIXELS_TOTAL;
  for (const [key, bytes] of env.rawImages) {
    let entry: { image: PDFImage; w: number; h: number } | null = null;
    checkDeadline(env);
    const pixels = bytes && isPng(bytes) ? pngPixels(bytes) : 0;
    const affordable = !bytes || !isPng(bytes) || (pixels > 0 && pixels <= MAX_PNG_PIXELS_EACH && pixels <= pngBudget);
    if (bytes && affordable) {
      pngBudget -= pixels;
      try {
        const image = isPng(bytes) ? await doc.embedPng(bytes) : isJpeg(bytes) ? await doc.embedJpg(new Uint8Array(bytes)) : null;
        // Pixels are treated as CSS pixels (96 per inch), which is what Word and browsers assume.
        if (image && image.width > 0 && image.height > 0) entry = { image, w: image.width * 0.75, h: image.height * 0.75 };
      } catch {
        entry = null;
      }
    }
    if (!entry) env.skippedImages += 1;
    env.images.set(key, entry);
  }
}

async function typesetBlocks(build: (env: Env) => Block[], options: TypesetOptions): Promise<TypesetResult> {
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc, ["regular", "bold", "italic", "boldItalic"] as const);
  const maxPages = options.maxPages ?? LIMITS.maxPages;
  const env: Env = { deadline: Date.now() + TYPESET_BUDGET_MS, maxPages, fonts, images: new Map(), rawImages: new Map(), options, replaced: false, skippedImages: 0, drew: false };

  const blocks = build(env);
  // Text that could not fit in the page limit even if every character were as narrow as the
  // narrowest glyph is refused here, before a single word is measured.
  if (minimumArea(blocks) > maxPages * CONTENT_W * CONTENT_H) throw tooManyPages(maxPages);
  await embedImages(doc, env);

  const flow = new Flow(doc, maxPages);
  // Blocks are laid out and placed one at a time so an enormous input stops at the
  // page limit instead of being measured in full first.
  for (const block of blocks) {
    checkDeadline(env);
    flow.run(layoutBlock(block, CONTENT_W, env));
  }

  const count = flow.pages.length;
  flow.pages.forEach((page, i) => {
    const label = `Page ${i + 1} of ${count}`;
    const w = fonts.regular.widthOfTextAtSize(label, 9);
    page.drawText(label, { x: (PAGE_W - w) / 2, y: MARGIN / 2, size: 9, font: fonts.regular, color: FOOTER });
  });

  const title = options.title?.trim();
  if (title) doc.setTitle(title);
  doc.setProducer("Signgate");
  doc.setCreator("Signgate");

  const pdf = await doc.save();
  return { pdf, pageCount: count, hasContent: env.drew, skippedImages: env.skippedImages, replacedCharacters: env.replaced };
}

/** The contents of the document's <title>, if it has one. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html.slice(0, 200_000));
  if (!m) return undefined;
  try {
    const text = parse(`<p>${m[1]}</p>`).text.replace(/\s+/g, " ").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Typesets HTML. Throws DocumentError("too_many_pages") when the result would exceed the page limit. */
export async function typesetHtml(html: string, options: TypesetOptions = {}): Promise<TypesetResult> {
  return typesetBlocks((env) => {
    try {
      return htmlToBlocks(html, env);
    } catch {
      // Markup the parser cannot cope with still has words in it; keep them.
      return textToBlocks(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]{0,2000}>/g, " "));
    }
  }, options);
}

/** Typesets plain text: blank lines separate paragraphs, line breaks, spaces, tabs and underscores are kept. */
export async function typesetText(text: string, options: TypesetOptions = {}): Promise<TypesetResult> {
  return typesetBlocks(() => textToBlocks(text), options);
}
