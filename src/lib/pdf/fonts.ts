/**
 * Fonts for all text the engine writes: converted documents, stamped field
 * values, the signature page and the certificate. Noto Sans is embedded (rather
 * than the 14 built-in PDF fonts) because client names are not limited to
 * Western European characters and the built-ins throw on anything outside WinAnsi.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

const FILES = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-Bold.ttf",
  italic: "NotoSans-Italic.ttf",
  boldItalic: "NotoSans-BoldItalic.ttf",
} as const;

export type FontStyle = keyof typeof FILES;
export type FontSet = Record<FontStyle, PDFFont>;

const bytesCache = new Map<FontStyle, Promise<Buffer>>();

function fontBytes(style: FontStyle): Promise<Buffer> {
  let cached = bytesCache.get(style);
  if (!cached) {
    cached = readFile(path.join(FONT_DIR, FILES[style]));
    bytesCache.set(style, cached);
  }
  return cached;
}

/**
 * Embeds the requested styles into the document. Fonts are subset on save, so a
 * sealed agreement grows by tens of kilobytes, not the size of the font files.
 */
export async function embedFonts<S extends FontStyle>(doc: PDFDocument, styles: readonly S[]): Promise<Record<S, PDFFont>> {
  doc.registerFontkit(fontkit);
  const out = {} as Record<S, PDFFont>;
  for (const style of styles) {
    out[style] = await doc.embedFont(await fontBytes(style), { subset: true });
    primeGlyphCodePoints(out[style]);
  }
  return out;
}

interface FontkitFont {
  characterSet?: number[];
  glyphForCodePoint?: (codePoint: number) => unknown;
}

/**
 * Makes text drawn with the font copy and search correctly. fontkit caches one
 * object per glyph and remembers only the code points of whoever asked first;
 * pdf-lib then writes those into the PDF's glyph-to-text map. Without this, the
 * first use of "i" being inside a decomposed Vietnamese "\u1ecb" makes every "i" in
 * the document extract as "\u1ecb", and the combining dot extracts as garbage.
 * Asking for every glyph by its own code point first pins the right answer.
 */
function primeGlyphCodePoints(font: PDFFont): void {
  try {
    const fk = (font as unknown as { embedder?: { font?: FontkitFont } }).embedder?.font;
    if (!fk?.characterSet || typeof fk.glyphForCodePoint !== "function") return;
    // Ascending order, so where two characters share a glyph (space and no-break space) the plain one wins.
    for (const codePoint of fk.characterSet) fk.glyphForCodePoint(codePoint);
  } catch {
    // Extraction quality only; drawing is unaffected, so never fail an embed over it.
  }
}

const supportCache = new WeakMap<PDFFont, Set<number>>();

function supported(font: PDFFont): Set<number> {
  let set = supportCache.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    supportCache.set(font, set);
  }
  return set;
}

/**
 * Returns text that is safe to draw with the font: control characters removed,
 * whitespace normalized, and any character the font cannot render replaced, so
 * drawing never throws on arbitrary user input.
 */
export function safeText(font: PDFFont, text: string, replacement = "?"): string {
  const set = supported(font);
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\t" || ch === " ") out += " ";
    else if (code < 0x20 || code === 0x7f) continue;
    else if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    else out += set.has(code) ? ch : replacement;
  }
  return out;
}

/** True when every visible character of the text can be rendered by the font. */
export function canRender(font: PDFFont, text: string): boolean {
  const set = supported(font);
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || code === 0x200b || code === 0xfeff) continue;
    if (ch !== "\t" && ch !== " " && !set.has(code)) return false;
  }
  return true;
}
