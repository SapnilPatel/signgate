/**
 * Turns whatever a company uploads into one normalized PDF the rest of the engine
 * can rely on: unencrypted, no interactive form, no scripts, sane page boxes, and
 * saved by pdf-lib so later stamping and sealing cannot trip over the original
 * file's quirks.
 *
 * The file type is decided from the bytes. Filenames and browser MIME types are
 * wrong often enough (a .pdf that is really a Word file, a .doc that is HTML)
 * that trusting them would fail real uploads.
 */
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFField,
  type PDFImage,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { LIMITS, type Field, type FieldType, type PageInfo } from "@/lib/types";
import { newId } from "@/lib/ids";
import { DocumentError, type IngestInput, type IngestResult, type SourceKind } from "./types";
import { displaySize, pdfRectToFrac } from "./geometry";
import { htmlTitle, typesetHtml, typesetText, type TypesetResult } from "./typeset";
import { applyTabLeaders, listZipEntries, type ZipEntry } from "./ingest-zip";
import { jpegInfo, pngSize, ORIENTATION_MATRIX } from "./ingest-image";

const LETTER = { width: 612, height: 792 };
const IMAGE_MARGIN = 36;
const MAX_IMAGE_PIXELS = 80_000_000;
/** A zip can expand enormously; refuse before handing it to a decompressor. */
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;
const FALLBACK_TITLE = "Agreement";

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

const SAVE_AS_PDF = "Save it as PDF or .docx and upload again.";

function unsupported(what: string): DocumentError {
  return new DocumentError("unsupported_type", `This looks like ${what}, which cannot be used as an agreement here. ${SAVE_AS_PDF}`);
}

function corruptPdf(): DocumentError {
  return new DocumentError(
    "corrupt",
    "This PDF could not be read. It may be damaged or only partly downloaded. Open it on your computer, choose Print, then Save as PDF to make a clean copy, and upload that.",
  );
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

type Sniffed =
  | { kind: "pdf"; offset: number }
  | { kind: "png" | "jpeg" }
  | { kind: "zip" }
  | { kind: "unsupported"; what: string }
  | { kind: "textual" };

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function sniff(bytes: Uint8Array): Sniffed {
  // Like Acrobat, accept a PDF header anywhere in the first kilobyte: files that
  // passed through mail gateways and scanners often carry junk before it.
  const head = ascii(bytes, 0, 1024 + 5);
  const pdfAt = head.indexOf("%PDF-");
  if (pdfAt === 0) return { kind: "pdf", offset: 0 };

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "jpeg" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return { kind: "zip" };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { kind: "unsupported", what: "an older Microsoft Office file (.doc, .xls or .ppt) or a password-protected Office file" };
  }
  if (head.startsWith("{\\rtf")) return { kind: "unsupported", what: "a Rich Text (.rtf) file" };
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return { kind: "unsupported", what: "a GIF image" };
  if (head.startsWith("RIFF") && ascii(bytes, 8, 12) === "WEBP") return { kind: "unsupported", what: "a WebP image" };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: "unsupported", what: "a TIFF image" };
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(brand)) return { kind: "unsupported", what: "a HEIC photo (the iPhone camera format)" };
    if (/^avi[fs]/.test(brand)) return { kind: "unsupported", what: "an AVIF image" };
    return { kind: "unsupported", what: "a video or audio file" };
  }
  if (head.startsWith("BM") && bytes.length > 26 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0) {
    return { kind: "unsupported", what: "a BMP image" };
  }
  if (head.startsWith("%!PS")) return { kind: "unsupported", what: "a PostScript file" };
  if (startsWith(bytes, [0x1f, 0x8b])) return { kind: "unsupported", what: "a gzip archive" };
  if (head.startsWith("Rar!") || startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf])) return { kind: "unsupported", what: "a compressed archive" };
  if (startsWith(bytes, [0x4d, 0x5a]) && bytes.length > 64 && ascii(bytes, 0, 1024).includes("This program")) {
    return { kind: "unsupported", what: "a program, not a document" };
  }

  if (pdfAt > 0) return { kind: "pdf", offset: pdfAt };
  return { kind: "textual" };
}

function describeZip(entries: ZipEntry[]): "docx" | string {
  const names = entries.map((e) => e.name.replace(/\\/g, "/"));
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/^word\/document\d*\.xml$/i) || (has(/^\[Content_Types\]\.xml$/) && has(/^word\//i))) return "docx";
  if (has(/^xl\//i)) return "an Excel spreadsheet";
  if (has(/^ppt\//i)) return "a PowerPoint presentation";
  if (has(/^visio\//i)) return "a Visio drawing";
  if (has(/\.iwa$/i) || has(/^index\.apxl$/i) || has(/^QuickLook\//i)) return "an Apple Pages, Numbers or Keynote file";
  if (has(/^META-INF\/container\.xml$/i)) return "an e-book";
  if (has(/^mimetype$/) && has(/^content\.xml$/)) return "an OpenDocument (LibreOffice) file";
  return "a zip archive";
}

/** Decodes text honouring a byte-order mark; returns null when the bytes are not text. */
function decodeText(bytes: Uint8Array): string | null {
  const decode = (label: string, from: number, fatal = false) => new TextDecoder(label, { fatal }).decode(bytes.subarray(from));
  try {
    if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return decode("utf-8", 3);
    if (startsWith(bytes, [0xff, 0xfe])) return decode("utf-16le", 2);
    if (startsWith(bytes, [0xfe, 0xff])) return decode("utf-16be", 2);
  } catch {
    return null;
  }

  const sample = bytes.subarray(0, 4096);
  let zerosEven = 0;
  let zerosOdd = 0;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) {
      if (i % 2 === 0) zerosEven += 1;
      else zerosOdd += 1;
    } else if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control += 1;
  }
  // UTF-16 saved without a BOM (Windows Notepad "Unicode"): every other byte is zero for Latin text.
  const half = sample.length / 2;
  if (sample.length >= 4 && bytes.length % 2 === 0) {
    try {
      if (zerosOdd > half * 0.6 && zerosEven < half * 0.05) return decode("utf-16le", 0);
      if (zerosEven > half * 0.6 && zerosOdd < half * 0.05) return decode("utf-16be", 0);
    } catch {
      return null;
    }
  }
  if (zerosEven + zerosOdd > 0 || control > sample.length * 0.02) return null;
  try {
    return decode("utf-8", 0, true);
  } catch {
    // Not valid UTF-8 but printable: a file saved in the old Windows encoding.
    try {
      return decode("windows-1252", 0);
    } catch {
      return null;
    }
  }
}

function looksLikeHtml(text: string): boolean {
  const start = text.slice(0, 2000).trimStart().toLowerCase();
  if (/^(<!doctype\s+html|<html[\s>]|<\?xml[^>]*>\s*(<!doctype\s+html|<html[\s>]))/.test(start)) return true;
  if (!start.startsWith("<")) return false;
  return /<\/(p|div|html|body|table|h[1-6]|span|ul|ol|section|article|b|strong|u|i|em)\s*>/i.test(text.slice(0, 200_000));
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

function cleanTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

function titleFromFilename(filename: string): string {
  let name = String(filename ?? "");
  if (/%[0-9a-f]{2}/i.test(name)) {
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
  }
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_+]+/g, " ");
  return cleanTitle(name) || FALLBACK_TITLE;
}

/** A metadata title is used only when a person plausibly wrote it; authoring tools fill it with junk. */
function realTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let title = cleanTitle(raw.replace(/^microsoft word - /i, ""));
  if (/\.(docx?|pdf|rtf|txt|pages|odt|dotx?|indd|ai|pptx?|xlsx?)$/i.test(title)) title = cleanTitle(title.replace(/\.[a-z]{2,5}$/i, ""));
  if (title.length < 3 || !/\p{L}{2}/u.test(title)) return undefined;
  if (/^(untitled|document|doc|new document|scan|scanned document|title|blank|template|print|null|undefined)[\s\d._-]*$/i.test(title)) return undefined;
  if (/^(scan|img|image|doc|document|file|page)[\s_-]?\d+$/i.test(title)) return undefined;
  if (/\ufffd/.test(title)) return undefined;
  return title;
}

// ---------------------------------------------------------------------------
// PDF normalization
// ---------------------------------------------------------------------------

const N = (name: string) => PDFName.of(name);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normRect(box: Rect): Rect | null {
  const { x, y, width, height } = box;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
}

const sameRect = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 && Math.abs(a.width - b.width) < 0.001 && Math.abs(a.height - b.height) < 0.001;

/**
 * Makes every page's boxes and rotation unambiguous, resolving odd values the same
 * way pdf.js does. The browser positions fields on a pdf.js rendering while the
 * server stamps with pdf-lib; if the two disagreed about a page's visible area,
 * signatures would land in the wrong place.
 */
function normalizePage(page: PDFPage) {
  let media: Rect | null = null;
  let raw: Rect | null = null;
  try {
    raw = page.getMediaBox();
    media = normRect(raw);
  } catch {
    media = null;
  }
  if (!media || media.width < 1 || media.height < 1) {
    media = { x: 0, y: 0, ...LETTER };
    page.setMediaBox(media.x, media.y, media.width, media.height);
  } else if (!raw || !sameRect(raw, media)) {
    page.setMediaBox(media.x, media.y, media.width, media.height);
  }

  let hasCrop = false;
  try {
    hasCrop = page.node.CropBox() !== undefined;
  } catch {
    hasCrop = true;
  }
  if (hasCrop) {
    let rawCrop: Rect | null = null;
    let crop: Rect | null = null;
    try {
      rawCrop = page.getCropBox();
      crop = normRect(rawCrop);
    } catch {
      crop = null;
    }
    let visible = media;
    if (crop) {
      const x1 = Math.max(crop.x, media.x);
      const y1 = Math.max(crop.y, media.y);
      const x2 = Math.min(crop.x + crop.width, media.x + media.width);
      const y2 = Math.min(crop.y + crop.height, media.y + media.height);
      if (x2 - x1 >= 1 && y2 - y1 >= 1) visible = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
    if (!rawCrop || !sameRect(rawCrop, visible)) page.setCropBox(visible.x, visible.y, visible.width, visible.height);
  }

  let angle = 0;
  let rawAngle: number | null = null;
  try {
    rawAngle = page.getRotation().angle;
    if (Number.isFinite(rawAngle) && rawAngle % 90 === 0) angle = ((rawAngle % 360) + 360) % 360;
  } catch {
    rawAngle = null;
  }
  if (rawAngle !== angle) page.setRotation(degrees(angle));
}

const ACTIVE_ACTIONS = new Set(["JavaScript", "Launch", "ImportData", "SubmitForm", "ResetForm", "Rendition", "RichMediaExecute", "GoToR", "GoToE", "Movie", "Sound"]);

function isActiveAction(dict: PDFDict): boolean {
  const s = dict.get(N("S"));
  if (s instanceof PDFName && ACTIVE_ACTIONS.has(s.decodeText())) return true;
  return dict.has(N("JS"));
}

/**
 * Removes everything that can run or reach out when the PDF is opened or clicked.
 * An agreement only needs to be read and signed; scripts in an uploaded file would
 * otherwise run in every client's PDF viewer.
 */
function stripActiveContent(doc: PDFDocument) {
  const ctx = doc.context;
  const resolveDict = (value: PDFObject | undefined): PDFDict | null => {
    try {
      const target = value instanceof PDFRef ? ctx.lookup(value) : value;
      return target instanceof PDFDict ? target : target instanceof PDFStream ? target.dict : null;
    } catch {
      return null;
    }
  };

  const scrub = (obj: PDFObject, depth: number) => {
    if (depth > 12) return;
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const item = obj.get(i);
        if (item instanceof PDFDict || item instanceof PDFArray) scrub(item, depth + 1);
      }
      return;
    }
    if (!(obj instanceof PDFDict)) return;
    for (const [key, value] of obj.entries()) {
      const name = key.decodeText();
      if (name === "AA" || name === "OpenAction") {
        obj.delete(key);
      } else if (name === "Next" && obj.has(N("S"))) {
        // Chained actions run after the visible one; a harmless link must not carry a hidden follow-up.
        obj.delete(key);
      } else if ((name === "A" || name === "PA") && isActiveAction(resolveDict(value) ?? ctx.obj({}))) {
        obj.delete(key);
      } else if (value instanceof PDFDict || value instanceof PDFArray) {
        scrub(value, depth + 1);
      }
    }
  };

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (dict && !(obj instanceof PDFStream) && isActiveAction(dict)) {
      // Delete the script itself too, not just the link to it, so it is not in the saved file at all.
      const js = dict.get(N("JS"));
      if (js instanceof PDFRef) ctx.delete(js);
      ctx.delete(ref);
      continue;
    }
    if (dict) scrub(dict, 0);
    else if (obj instanceof PDFArray) scrub(obj, 0);
  }

  const names = resolveDict(doc.catalog.get(N("Names")));
  if (names) names.delete(N("JavaScript"));
}

function fieldTypeFor(field: PDFField, hint: string): FieldType {
  if (field instanceof PDFSignature) return "signature";
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) return "checkbox";
  const text = hint
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.\-[\]#/:]+/g, " ")
    .toLowerCase();
  if (/\bdate|dated\b|\bdt\b/.test(text)) return /birth|\bdob\b|effective|start|end\b|expir|due|commenc|from|until/.test(text) ? "date" : "date_signed";
  if (/e-?mail/.test(text)) return "email";
  if (/\binitial/.test(text)) return "initials";
  if (/\btitle\b|position|designation|job/.test(text)) return "title";
  if (/company|organi[sz]ation|business|employer|\bfirm\b|entity/.test(text)) return "company";
  if (/name|printed|\bprint\b/.test(text)) return "full_name";
  if (/sign|\bsig\b|autograph/.test(text)) return "signature";
  return "text";
}

const TYPE_LABELS: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date_signed: "Date signed",
  full_name: "Full name",
  title: "Title",
  company: "Company",
  email: "Email",
  text: "Text",
  date: "Date",
  checkbox: "Checkbox",
};

function pdfString(value: PDFObject | undefined): string {
  try {
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  } catch {
    // undecodable strings are treated as absent
  }
  return "";
}

function hasAppearance(widgetDict: PDFDict): boolean {
  try {
    const ap = widgetDict.lookup(N("AP"));
    if (!(ap instanceof PDFDict)) return false;
    const normal = ap.lookup(N("N"));
    return normal instanceof PDFStream || normal instanceof PDFDict;
  } catch {
    return false;
  }
}

function fieldHasValue(field: PDFField): boolean {
  try {
    if (field instanceof PDFTextField) return Boolean(field.getText()?.trim());
    if (field instanceof PDFCheckBox) return field.isChecked();
    if (field instanceof PDFRadioGroup) return field.getSelected() !== undefined;
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected().length > 0;
    return field.acroField.dict.has(N("V"));
  } catch {
    // A value we cannot read is still a value: do not put a field on top of it.
    return true;
  }
}

function safeFields(doc: PDFDocument): PDFField[] {
  try {
    return doc.getForm().getFields();
  } catch {
    return [];
  }
}

/** Recovers the places the form's author marked for input, so they become fields automatically. */
function recoverFormFields(doc: PDFDocument, warnings: string[]): Field[] {
  const pages = doc.getPages();
  const pageOfWidget = new Map<PDFDict, number>();
  pages.forEach((page, index) => {
    try {
      const annots = page.node.Annots();
      if (!annots) return;
      for (let i = 0; i < annots.size(); i++) {
        const annot = annots.lookup(i);
        if (annot instanceof PDFDict && !pageOfWidget.has(annot)) pageOfWidget.set(annot, index);
      }
    } catch {
      // a page with a broken annotation list simply contributes no fields
    }
  });

  const out: Field[] = [];
  let signed = false;
  for (const field of safeFields(doc)) {
    try {
      if (field instanceof PDFButton) continue;
      const filled = fieldHasValue(field);
      if (field instanceof PDFSignature && filled) signed = true;
      // A value already typed in is part of the agreement text; it is printed by
      // flattening and must not be offered to the signer as a blank.
      if (filled || field.isReadOnly()) continue;

      const name = field.getName();
      const tooltip = pdfString(field.acroField.dict.get(N("TU")));
      const type = fieldTypeFor(field, `${tooltip} ${name}`);
      const leaf = (name.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
      const label =
        cleanTitle(tooltip).slice(0, 80) ||
        cleanTitle(leaf.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ")).slice(0, 80) ||
        TYPE_LABELS[type];
      const required = type === "signature" || field.isRequired();

      for (const widget of field.acroField.getWidgets()) {
        if (out.length >= LIMITS.maxFieldsPerTemplate) return out;
        const flags = widget.dict.lookup(N("F"));
        const f = flags && "asNumber" in flags ? (flags as { asNumber(): number }).asNumber() : 0;
        // Hidden (bit 2) and NoView (bit 6) widgets are not shown to a reader.
        if (f & 0x02 || f & 0x20) continue;
        let index = pageOfWidget.get(widget.dict);
        if (index === undefined) {
          const p = widget.P();
          index = p ? pages.findIndex((page) => page.ref === p) : -1;
        }
        if (index === undefined || index < 0) continue;
        const rect = widget.getRectangle();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
        const frac = pdfRectToFrac(pages[index], rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
        if (frac.w < 0.004 || frac.h < 0.003) continue;
        out.push({ id: newId("fld"), page: index, ...frac, type, role: "client", required, label, source: "form" });
      }
    } catch {
      // One malformed field must not cost the rest of the form.
    }
  }
  if (signed) {
    warnings.push(
      "This PDF carried a digital signature. Preparing it for signing here changes the file, so that earlier signature no longer validates on the stored copy.",
    );
  }
  return out;
}

/** Drops annotation entries that point at nothing and, when asked, every form widget. */
function tidyAnnotations(doc: PDFDocument, dropWidgets: boolean) {
  for (const page of doc.getPages()) {
    try {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const annot = annots.lookup(i);
        // Flattening deletes widget objects but can leave their references behind.
        if (!(annot instanceof PDFDict)) annots.remove(i);
        else if (dropWidgets && annot.get(N("Subtype")) === N("Widget")) annots.remove(i);
      }
    } catch {
      // Unreadable annotation list: drop it rather than keep something interactive.
      page.node.delete(N("Annots"));
    }
  }
}

type FormStrategy = "flatten" | "flatten-as-is" | "remove";

/**
 * Takes a field and its widgets out of the document. pdf-lib's own removeField
 * throws on a widget without an appearance stream, which is exactly the kind of
 * field that needs removing.
 */
function dropField(doc: PDFDocument, field: PDFField) {
  const widgets = new Set<PDFDict>(field.acroField.getWidgets().map((w) => w.dict));
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookup(i);
      if (annot instanceof PDFDict && widgets.has(annot)) annots.remove(i);
    }
  }
  doc.getForm().acroForm.removeField(field.acroField);
}

function widgetsOnPages(doc: PDFDocument): Set<PDFDict> {
  const placed = new Set<PDFDict>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      if (annot instanceof PDFDict) placed.add(annot);
    }
  }
  return placed;
}

function flattenForm(doc: PDFDocument, strategy: FormStrategy) {
  if (strategy !== "remove") {
    const form = doc.getForm();
    const placed = widgetsOnPages(doc);
    for (const field of form.getFields()) {
      const widgets = field.acroField.getWidgets();
      const missing = widgets.some((w) => !hasAppearance(w.dict));
      const stray = widgets.some((w) => !placed.has(w.dict));
      // pdf-lib's flatten throws on a widget with nothing to draw or on no page.
      // Blank signature boxes and buttons have nothing worth printing; other
      // fields get an appearance generated, or are dropped on the second attempt.
      const regenerable =
        field instanceof PDFTextField ||
        field instanceof PDFDropdown ||
        field instanceof PDFOptionList ||
        field instanceof PDFCheckBox ||
        field instanceof PDFRadioGroup;
      if (strategy === "flatten") {
        if (missing && !regenerable) dropField(doc, field);
        else if (missing) form.markFieldAsDirty(field.ref);
      } else if (missing || stray) {
        dropField(doc, field);
      }
    }
    form.flatten({ updateFieldAppearances: strategy === "flatten" });
  }
  tidyAnnotations(doc, true);
  doc.catalog.delete(N("AcroForm"));
}

interface PdfOutcome {
  pdf: Uint8Array;
  pages: PageInfo[];
  formFields: Field[];
  warnings: string[];
  title: string | undefined;
}

async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    throw corruptPdf();
  }
  if (doc.isEncrypted) {
    throw new DocumentError(
      "password_protected",
      "This PDF is locked: it either needs a password to open or has restrictions on editing, so fields cannot be added to it. Open it on your computer, choose Print, then Save as PDF to make an unlocked copy, and upload that.",
    );
  }
  return doc;
}

async function normalizeOnce(bytes: Uint8Array, strategy: FormStrategy | "none"): Promise<PdfOutcome> {
  const doc = await loadSource(bytes);
  const warnings: string[] = [];

  let count: number;
  try {
    count = doc.getPageCount();
    doc.getPages();
  } catch {
    throw corruptPdf();
  }
  if (count === 0) {
    throw new DocumentError("empty", "This PDF has no pages. Check that you picked the right file, then upload the agreement again.");
  }
  if (count > LIMITS.maxPages) {
    throw new DocumentError(
      "too_many_pages",
      `This PDF has ${count} pages; the most an agreement can have here is ${LIMITS.maxPages}. Upload just the agreement, without attachments or appendices that do not need signing.`,
    );
  }

  for (const page of doc.getPages()) normalizePage(page);
  stripActiveContent(doc);

  let formFields: Field[] = [];
  let acroForm: PDFDict | null = null;
  try {
    const value = doc.catalog.lookup(N("AcroForm"));
    acroForm = value instanceof PDFDict ? value : null;
  } catch {
    acroForm = null;
  }
  if (acroForm) {
    if (acroForm.has(N("XFA"))) {
      const xfa = acroForm.get(N("XFA"));
      const parts = xfa instanceof PDFRef ? doc.context.lookup(xfa) : xfa;
      if (parts instanceof PDFArray) {
        for (let i = 0; i < parts.size(); i++) {
          const part = parts.get(i);
          if (part instanceof PDFRef) doc.context.delete(part);
        }
      }
      if (xfa instanceof PDFRef) doc.context.delete(xfa);
      acroForm.delete(N("XFA"));
      warnings.push(
        "This PDF was built as an Adobe dynamic (XFA) form, and that part was removed. If the pages show a \"Please wait\" message instead of your agreement, open the file in Adobe Acrobat, choose Print, then Save as PDF, and upload that copy.",
      );
    }
    formFields = recoverFormFields(doc, warnings);
    const effective = strategy === "none" ? "flatten" : strategy;
    flattenForm(doc, effective);
    if (effective === "remove") {
      warnings.push(
        "The fillable form in this PDF could not be converted to printed content, so its boxes were removed. Anything that had been typed into the form is not on the stored copy; check the preview.",
      );
    }
  } else {
    doc.catalog.delete(N("AcroForm"));
    tidyAnnotations(doc, false);
  }

  let title: string | undefined;
  try {
    title = doc.getTitle();
  } catch {
    title = undefined;
  }

  // Appearances were settled during flattening; letting save regenerate them would
  // re-run the step that the fallback strategies exist to avoid.
  const pdf = await doc.save({ updateFieldAppearances: false });
  // Proof that what is stored can be opened and modified again later.
  const check = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = check.getPages().map((page) => displaySize(page));
  if (pages.length !== count) throw new Error("page count changed during normalization");
  return { pdf, pages, formFields, warnings, title };
}

async function normalizePdf(bytes: Uint8Array): Promise<PdfOutcome> {
  // Each attempt starts from the original bytes: a flatten that fails part-way
  // leaves the document half converted.
  const strategies: (FormStrategy | "none")[] = ["flatten", "flatten-as-is", "remove"];
  for (const strategy of strategies) {
    try {
      return await normalizeOnce(bytes, strategy);
    } catch (error) {
      if (error instanceof DocumentError) throw error;
    }
  }
  throw corruptPdf();
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function unreadableImage(): DocumentError {
  return new DocumentError(
    "corrupt",
    "This image could not be read. It may be damaged. Open it, save it again as a PDF, PNG or JPEG, and upload that.",
  );
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<{ image: PDFImage; orientation: number }> {
  const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
  const jpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (!png && !jpeg) throw unreadableImage();
  const info = png ? { size: pngSize(bytes), orientation: 1 } : jpegInfo(bytes);
  if (!info.size || info.size.width < 1 || info.size.height < 1) throw unreadableImage();
  if (info.size.width * info.size.height > MAX_IMAGE_PIXELS) {
    throw new DocumentError(
      "too_large",
      `This image is ${info.size.width} by ${info.size.height} pixels, which is too large to process. Export it at a lower resolution (300 dpi is plenty for a page) or save it as PDF, then upload again.`,
    );
  }
  try {
    // pdf-lib's JPEG reader ignores a view's offset into its buffer, so a slice of a
    // larger buffer (any Node Buffer from the pool) must be copied out first.
    const own = new Uint8Array(bytes);
    const image = png ? await doc.embedPng(own) : await doc.embedJpg(own);
    if (!(image.width > 0 && image.height > 0)) throw unreadableImage();
    return { image, orientation: info.orientation };
  } catch {
    throw unreadableImage();
  }
}

/** Draws the image upright into the rectangle, undoing the camera's EXIF rotation or mirroring. */
function drawOriented(page: PDFPage, image: PDFImage, orientation: number, x: number, y: number, w: number, h: number) {
  const m = ORIENTATION_MATRIX[orientation] ?? ORIENTATION_MATRIX[1];
  const name = page.node.newXObject("Img", image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(m.su * w, m.tu * h, m.sv * w, m.tv * h, x + m.s0 * w, y + m.t0 * h),
    drawObject(name),
    popGraphicsState(),
  );
}

async function finish(doc: PDFDocument, title: string): Promise<{ pdf: Uint8Array; pages: PageInfo[] }> {
  doc.setTitle(title);
  doc.setProducer("Signgate");
  doc.setCreator("Signgate");
  const pdf = await doc.save();
  const check = await PDFDocument.load(pdf, { updateMetadata: false });
  return { pdf, pages: check.getPages().map((page) => displaySize(page)) };
}

async function ingestImage(bytes: Uint8Array, title: string): Promise<IngestResult> {
  const doc = await PDFDocument.create();
  const { image, orientation } = await embedImage(doc, bytes);
  const sideways = orientation >= 5 && orientation <= 8;
  const pxW = sideways ? image.height : image.width;
  const pxH = sideways ? image.width : image.height;
  // A wide picture (a landscape scan, a screenshot) gets a landscape page so it is not shrunk to a strip.
  const landscape = pxW > pxH * 1.15;
  const pageW = landscape ? LETTER.height : LETTER.width;
  const pageH = landscape ? LETTER.width : LETTER.height;
  // Fill the printable area, but do not blow a small image up beyond one point per pixel.
  const scale = Math.min((pageW - 2 * IMAGE_MARGIN) / pxW, (pageH - 2 * IMAGE_MARGIN) / pxH, 1);
  const w = pxW * scale;
  const h = pxH * scale;
  const page = doc.addPage([pageW, pageH]);
  drawOriented(page, image, orientation, (pageW - w) / 2, (pageH - h) / 2, w, h);
  const out = await finish(doc, title);
  return { ...out, sourceKind: "image", title, formFields: [], warnings: [] };
}

/**
 * Builds a PDF from page pictures. This is the universal fallback: when the server
 * cannot open a PDF (locked, damaged, exotic), the browser renders each page with
 * pdf.js and uploads the pictures, so the agreement can still be signed.
 */
export async function ingestPageImages(
  images: { bytes: Uint8Array; widthPt: number; heightPt: number }[],
  title: string,
): Promise<IngestResult> {
  if (!Array.isArray(images) || images.length === 0) {
    throw new DocumentError("empty", "No pages were received. Upload the agreement again.");
  }
  if (images.length > LIMITS.maxPages) {
    throw new DocumentError(
      "too_many_pages",
      `This document has ${images.length} pages; the most an agreement can have here is ${LIMITS.maxPages}. Upload just the agreement, without attachments that do not need signing.`,
    );
  }
  const total = images.reduce((sum, img) => sum + (img?.bytes?.length ?? 0), 0);
  // Rendered pages are bulkier than the PDF they came from, so the ceiling is higher than for uploads.
  if (total > LIMITS.maxUploadBytes * 4) {
    throw new DocumentError(
      "too_large",
      `The pages of this document add up to ${mb(total)}, which is too large to store. Save a smaller copy of the PDF (for example with "Reduce file size") and upload again.`,
    );
  }
  const doc = await PDFDocument.create();
  for (const item of images) {
    if (!item || !(item.bytes instanceof Uint8Array) || item.bytes.length === 0) throw unreadableImage();
    const { image, orientation } = await embedImage(doc, item.bytes);
    const sideways = orientation >= 5 && orientation <= 8;
    const aspect = sideways ? image.height / image.width : image.width / image.height;
    const valid = (n: number) => Number.isFinite(n) && n >= 18 && n <= 14_400;
    // Page size comes from the caller; if it is missing or absurd, keep the picture's proportions on a Letter-width page.
    const width = valid(item.widthPt) ? item.widthPt : LETTER.width;
    const height = valid(item.heightPt) ? item.heightPt : Math.min(14_400, Math.max(18, width / aspect));
    const page = doc.addPage([width, height]);
    drawOriented(page, image, orientation, 0, 0, width, height);
  }
  const cleaned = cleanTitle(String(title ?? "")) || FALLBACK_TITLE;
  const out = await finish(doc, cleaned);
  return {
    ...out,
    sourceKind: "pdf",
    title: cleaned,
    formFields: [],
    warnings: [
      "This PDF could not be opened directly, so its pages were stored as pictures. It looks the same, but its text cannot be read, so signature and date fields have to be placed by hand.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Word, HTML and text
// ---------------------------------------------------------------------------

function typesetWarnings(result: TypesetResult): string[] {
  const warnings: string[] = [];
  if (result.skippedImages > 0) {
    warnings.push(
      result.skippedImages === 1
        ? "One picture in the document could not be included (only PNG and JPEG pictures stored inside the document are supported). Check the preview."
        : `${result.skippedImages} pictures in the document could not be included (only PNG and JPEG pictures stored inside the document are supported). Check the preview.`,
    );
  }
  if (result.replacedCharacters) {
    warnings.push(
      "Some characters (for example Chinese, Japanese, Korean, Arabic or Hebrew text, or symbols) could not be shown and appear as \"?\". Upload the agreement as a PDF to keep them.",
    );
  }
  return warnings;
}

function emptyDocument(): DocumentError {
  return new DocumentError("empty", "This file has no content. Check that you picked the right file, then upload the agreement again.");
}

async function packageTypeset(result: TypesetResult, sourceKind: SourceKind, title: string, warnings: string[]): Promise<IngestResult> {
  if (!result.hasContent) throw emptyDocument();
  const check = await PDFDocument.load(result.pdf, { updateMetadata: false });
  const pages = check.getPages().map((page) => displaySize(page));
  return { pdf: result.pdf, pages, sourceKind, title, formFields: [], warnings: [...warnings, ...typesetWarnings(result)] };
}

async function ingestDocx(bytes: Uint8Array, entries: ZipEntry[], title: string): Promise<IngestResult> {
  const unreadable = () =>
    new DocumentError(
      "corrupt",
      "This Word document could not be read. It may be damaged. Open it in Word, choose Save As and pick PDF, then upload the PDF.",
    );
  const expanded = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  if (expanded > MAX_UNZIPPED_BYTES) {
    throw new DocumentError(
      "too_large",
      `This Word document expands to ${mb(expanded)}, which is too large to convert. Save it as PDF (pictures are compressed on the way) and upload the PDF.`,
    );
  }

  let html: string;
  try {
    const prepared = await applyTabLeaders(bytes);
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(prepared.buffer, prepared.byteOffset, prepared.byteLength) },
      {
        // Underlines and page breaks are dropped by default; both matter here:
        // underlined blanks are signature lines.
        styleMap: ["u => u", "strike => s", "br[type='page'] => hr.page-break"],
        ignoreEmptyParagraphs: false,
        externalFileAccess: false,
      },
    );
    html = result.value;
  } catch {
    throw unreadable();
  }

  const result = await typesetHtml(html, { title, preserveTabs: true, keepEmptyParagraphs: true });
  return packageTypeset(result, "docx", title, [
    "Converted from Word. The wording is unchanged, but the layout was simplified: fonts, spacing, columns, headers and footers may look different. Check the preview, or upload the agreement as a PDF to keep its exact layout.",
  ]);
}

async function ingestHtml(html: string, filename: string): Promise<IngestResult> {
  const title = realTitle(htmlTitle(html)) ?? titleFromFilename(filename);
  const result = await typesetHtml(html, { title });
  return packageTypeset(result, "html", title, [
    "Converted from a web page. The wording is unchanged, but the layout was simplified. Check the preview, or upload the agreement as a PDF to keep its exact layout.",
  ]);
}

/** Typesets pasted or uploaded plain text into a signable PDF. */
export async function ingestText(text: string, title: string): Promise<IngestResult> {
  const body = typeof text === "string" ? text : "";
  if (!/[^\s\u200b\ufeff]/.test(body)) {
    throw new DocumentError("empty", "There is no text to turn into an agreement. Paste or type the agreement text, then try again.");
  }
  if (body.length > LIMITS.maxUploadBytes) {
    throw new DocumentError("too_large", `This text is too long. The limit is ${mb(LIMITS.maxUploadBytes)}; shorten it or upload it as a PDF.`);
  }
  const cleaned = cleanTitle(String(title ?? "")) || FALLBACK_TITLE;
  const result = await typesetText(body, { title: cleaned });
  return packageTypeset(result, "text", cleaned, []);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function ingestSniffed(bytes: Uint8Array, filename: string): Promise<IngestResult> {
  const fileTitle = titleFromFilename(filename);
  const type = sniff(bytes);

  switch (type.kind) {
    case "pdf": {
      const outcome = await normalizePdf(type.offset > 0 ? bytes.subarray(type.offset) : bytes);
      return {
        pdf: outcome.pdf,
        pages: outcome.pages,
        sourceKind: "pdf",
        title: realTitle(outcome.title) ?? fileTitle,
        formFields: outcome.formFields,
        warnings: outcome.warnings,
      };
    }
    case "png":
    case "jpeg":
      return ingestImage(bytes, fileTitle);
    case "zip": {
      const entries = listZipEntries(bytes);
      const what = describeZip(entries);
      if (what !== "docx") throw unsupported(what);
      return ingestDocx(bytes, entries, fileTitle);
    }
    case "unsupported":
      throw unsupported(type.what);
    case "textual": {
      const text = decodeText(bytes);
      if (text === null) throw unsupported("a file type that is not a document Signgate can read");
      if (!/[^\s\u200b\ufeff]/.test(text)) throw emptyDocument();
      if (looksLikeHtml(text)) return ingestHtml(text, filename);
      if (/^\s*<\?xml/i.test(text.slice(0, 200))) throw unsupported("an XML data file");
      const result = await typesetText(text, { title: fileTitle });
      return packageTypeset(result, "text", fileTitle, []);
    }
  }
}

/**
 * Converts an uploaded file into a normalized, signable PDF.
 * Throws DocumentError for anything that cannot be used; its message is written for the uploader.
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const bytes = input?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw emptyDocument();
  if (bytes.length > LIMITS.maxUploadBytes) {
    throw new DocumentError(
      "too_large",
      `This file is ${mb(bytes.length)}; the limit is ${mb(LIMITS.maxUploadBytes)}. Save a smaller copy (in most PDF apps: Export or "Reduce file size") and upload again.`,
    );
  }
  let blank = true;
  for (let i = 0; i < bytes.length && blank; i++) {
    const b = bytes[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x00) blank = false;
  }
  if (blank) throw emptyDocument();

  try {
    return await ingestSniffed(bytes, String(input.filename ?? ""));
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    // Anything unexpected from a parser is, to the uploader, a file that could not be read.
    throw new DocumentError(
      "corrupt",
      "This file could not be read. It may be damaged. Save it again as a PDF (Print, then Save as PDF) and upload that.",
    );
  }
}
