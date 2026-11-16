/**
 * Finds where an agreement nobody has seen before needs to be filled in and
 * signed. Strategies stack: form widgets recovered at ingest, rules over the
 * page geometry, an optional AI review, and finally an appended signature page,
 * so the result can always be signed. Nothing here throws.
 */
import type { Field, PageInfo } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import { env } from "@/lib/env";
import type { DetectionMeta, DetectOptions, DetectionResult } from "../types";
import { getPages, loadPdf } from "../pages";
import { drawSignaturePage } from "../signature-page";
import { extractLayout, type ExtractedLayout } from "../text";
import { newId } from "@/lib/ids";
import { anthropicCaller, applyScannedResult, applyTextReview, buildScannedRequest, buildTextRequest, callWithDeadline, AI_TIMEOUT_MS, type AiCaller } from "./ai";
import { buildModel } from "./layout";
import { detectByRules, finalizeFields, type RuleResult } from "./rules";

export interface DetectDeps {
  /** Replaces the Anthropic call; used by tests so they never touch the network. */
  ai?: AiCaller;
  aiTimeoutMs?: number;
  /** Time allowed for the rule-based pass; tests shorten it. */
  rulesTimeoutMs?: number;
}

/** Reading a hostile or enormous file must not hold the upload hostage. */
const LAYOUT_TIMEOUT_MS = 20_000;
/** The rules normally finish in well under a second; past this the document is answered with a signature page instead. */
const RULES_TIMEOUT_MS = 8_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hasClientSignature = (fields: Field[]) => fields.some((f) => f.type === "signature" && f.role === "client");

function sanitizeFormFields(input: unknown, pageCount: number): Field[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const raw of input as Partial<Field>[]) {
    if (!raw || typeof raw !== "object") continue;
    const { page, x, y, w, h } = raw;
    if (!Number.isInteger(page) || page! < 0 || page! >= pageCount) continue;
    if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    if (!(w! > 0 && h! > 0)) continue;
    let id = typeof raw.id === "string" && raw.id ? raw.id : newId("fld");
    if (seen.has(id)) id = newId("fld");
    seen.add(id);
    out.push({
      id,
      page: page!,
      x: x!,
      y: y!,
      w: w!,
      h: h!,
      type: raw.type ?? "text",
      role: raw.role ?? "client",
      required: Boolean(raw.required),
      label: typeof raw.label === "string" ? raw.label : "",
      mergeKey: raw.mergeKey,
      source: "form",
      confidence: raw.confidence,
    });
  }
  return out.slice(0, LIMITS.maxFieldsPerTemplate);
}

async function readLayout(pdf: Uint8Array): Promise<ExtractedLayout> {
  const empty: ExtractedLayout = { items: [], pageText: [], scanned: true, pages: [], runs: [], rules: [], vrules: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      extractLayout(pdf),
      new Promise<ExtractedLayout>((resolve) => {
        timer = setTimeout(() => resolve(empty), LAYOUT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return empty;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function meta(method: DetectionMeta["method"], scanned: boolean, notes: string[], appended = false): DetectionMeta {
  return { method, signaturePageAppended: appended, scanned, notes, detectedAt: new Date().toISOString() };
}

/** A place to sign when even the signature page cannot be added: the foot of the last page. */
function footOfLastPage(pages: PageInfo[]): Field {
  return {
    id: newId("fld"),
    page: pages.length - 1,
    x: 0.08,
    y: 0.9,
    w: 0.4,
    h: 0.05,
    type: "signature",
    role: "client",
    required: true,
    label: "Client signature",
    source: "detected",
    confidence: 0.2,
  };
}

async function detect(pdf: Uint8Array, options: DetectOptions, deps: DetectDeps): Promise<DetectionResult> {
  const notes: string[] = [];
  const layout = await readLayout(pdf);
  let pages: PageInfo[];
  try {
    pages = await getPages(pdf);
  } catch {
    pages = layout.pages;
  }
  if (!pages.length) {
    return {
      pdf,
      pages: [],
      fields: [],
      meta: meta("none", true, ["This file could not be opened as a PDF, so no fields were placed. Upload the agreement again, or export it to PDF first."]),
    };
  }

  const companyName = typeof options.companyName === "string" && options.companyName.trim() ? options.companyName.trim().slice(0, 200) : undefined;
  const formFields = sanitizeFormFields(options.formFields, pages.length);
  // Fractions are relative to each page, so the reader's own page sizes are the right
  // basis for its coordinates even if they differ slightly from pdf-lib's.
  const usable = layout.pages.length === pages.length;
  const model = buildModel(usable ? layout : { ...layout, pages, runs: [], rules: [], vrules: [], items: [] }, formFields);
  let rule: RuleResult;
  try {
    rule = detectByRules(model, companyName, { deadline: Date.now() + (deps.rulesTimeoutMs ?? RULES_TIMEOUT_MS) });
  } catch {
    // Out of time, or a layout the rules could not cope with. The form's own fields are still trustworthy.
    rule = {
      fields: formFields,
      origins: new Map(),
      model,
      stats: { signatureBlocks: 0, clientSignatures: 0, companySignatures: 0, guessedRoles: false, prefills: 0, openBlanks: 0, initials: 0, witnessLines: 0, skippedBlanks: 0 },
    };
    notes.push("This document has too many blanks and lines to analyse automatically. Place the fields you need by hand in the editor.");
  }
  if (rule.stats.skippedBlanks > 0)
    notes.push(`This document has a very large number of blanks. ${plural(rule.stats.skippedBlanks, "blank")} beyond the first ones on each page ${rule.stats.skippedBlanks === 1 ? "was" : "were"} not looked at. Check the fields in the editor and add any that are missing.`);
  let fields = finalizeFields(rule.fields, pages.length, LIMITS.maxFieldsPerTemplate);
  const scanned = !usable || layout.scanned;
  let method: DetectionMeta["method"] = fields.some((f) => f.source === "form") ? "form" : fields.length ? "heuristic" : "none";

  // ---- Optional AI review ---------------------------------------------------
  const caller = options.useAI === false ? undefined : (deps.ai ?? (env.anthropicApiKey && !env.isTest ? anthropicCaller(env.anthropicApiKey) : undefined));
  if (caller) {
    try {
      const timeoutMs = deps.aiTimeoutMs ?? AI_TIMEOUT_MS;
      if (!scanned && model.lines.length) {
        const { request, candidateIds } = buildTextRequest(model, rule, fields, companyName);
        const reviewed = applyTextReview(await callWithDeadline(caller, request, timeoutMs), model, rule, fields, candidateIds);
        if (reviewed) {
          fields = finalizeFields(reviewed.fields, pages.length, LIMITS.maxFieldsPerTemplate);
          if (reviewed.changed) method = "ai";
          notes.push(...reviewed.notes);
        }
      } else if (scanned && !hasClientSignature(fields)) {
        const request = buildScannedRequest(pdf, pages, companyName);
        const read = request ? applyScannedResult(await callWithDeadline(caller, request, timeoutMs), pages) : null;
        if (read && hasClientSignature(read.fields)) {
          fields = finalizeFields([...fields, ...read.fields], pages.length, LIMITS.maxFieldsPerTemplate);
          method = "ai";
          notes.push("This document is a scan, so the fields were placed by reading the page images. Their positions are approximate: check each one in the editor.", ...read.notes);
        }
      }
    } catch {
      // The AI is an improvement, never a dependency.
    }
  }

  // ---- Notes for the sender -------------------------------------------------
  const signatures = fields.filter((f) => f.type === "signature");
  const clientSigs = signatures.filter((f) => f.role === "client").length;
  const companySigs = signatures.filter((f) => f.role === "company").length;
  if (signatures.length && method !== "ai") {
    const blocks = Math.max(rule.stats.signatureBlocks, 1);
    notes.push(
      blocks > 1 || companySigs
        ? `Found ${plural(blocks, "signature block")}. Check that the company block is assigned to your side.`
        : `Found ${plural(blocks, "signature block")} and assigned it to the client.`,
    );
    if (rule.stats.guessedRoles && blocks > 1) notes.push("The document does not say which block belongs to which party, so the first one was given to the client. Swap them in the editor if that is wrong.");
  } else if (signatures.length) {
    notes.push(`Found ${plural(signatures.length, "place")} to sign: ${clientSigs} for the client and ${companySigs} for your side.`);
  }
  const prefills = fields.filter((f) => f.role === "prefill").length;
  if (prefills) notes.push(`${plural(prefills, "blank")} in the text will be filled in automatically from each file (for example the date or the client's name). Check them in the editor.`);
  const open = fields.filter((f) => f.role === "client" && !f.required && f.source === "detected" && (f.confidence ?? 1) <= 0.5 && f.type !== "signature").length;
  if (open) notes.push(`${plural(open, "other blank")} could not be identified and ${open === 1 ? "was" : "were"} left as optional for the client. Remove any that should stay empty.`);
  const initialsCount = fields.filter((f) => f.type === "initials").length;
  if (initialsCount) notes.push(`Found ${plural(initialsCount, "place")} for initials.`);
  if (rule.stats.witnessLines) notes.push("A witness or notary line was found and left alone. Add a field by hand if someone else needs to sign there.");

  // ---- Guarantee: the client can always sign --------------------------------
  let outPdf = pdf;
  let appended = false;
  if (!hasClientSignature(fields)) {
    const why = scanned
      ? "This document is a scan with no readable text, so no place to sign could be found in it."
      : companySigs
        ? "The only signature block found belongs to your side."
        : "No place for the client to sign was found in this document.";
    try {
      const doc = await loadPdf(pdf);
      let title: string | undefined;
      try {
        const raw = doc.getTitle()?.trim();
        if (raw && raw.length <= 120 && !/^(untitled|document\d*|microsoft word)/i.test(raw)) title = raw;
      } catch {
        // metadata is optional
      }
      const page = await drawSignaturePage(doc, { companyName, includeCompany: false, agreementTitle: title });
      const bytes = await doc.save();
      outPdf = bytes;
      pages = await getPages(doc);
      // The added signature is the whole point of the page, so it goes in first and the detected
      // fields give way: a template may hold only so many, and what is cut must never be the signature.
      fields = [...page.fields, ...fields.slice(0, Math.max(0, LIMITS.maxFieldsPerTemplate - page.fields.length))];
      appended = true;
      if (method === "none") method = "appended";
      notes.unshift(`${why} A signature page was added at the end so the client can sign. You can also place fields by hand in the editor.`);
    } catch {
      fields = [footOfLastPage(pages), ...fields.slice(0, LIMITS.maxFieldsPerTemplate - 1)];
      notes.unshift(`${why} A signature field was placed at the foot of the last page. Move it to the right spot in the editor before sending.`);
    }
  }

  return { pdf: outPdf, pages, fields, meta: meta(method, scanned, notes, appended) };
}

/** Same as detectFields with the AI call injectable. */
export async function detectFieldsWith(pdf: Uint8Array, options: DetectOptions = {}, deps: DetectDeps = {}): Promise<DetectionResult> {
  try {
    return await detect(pdf, options ?? {}, deps);
  } catch {
    // Last line of defence: something unforeseen failed, but the sender still gets a usable answer.
    let pages: PageInfo[] = [];
    try {
      pages = await getPages(pdf);
    } catch {
      // not a PDF pdf-lib can open
    }
    const fields = pages.length ? [footOfLastPage(pages)] : [];
    const note = pages.length
      ? "The document could not be analysed, so a signature field was placed at the foot of the last page. Move it to the right spot in the editor before sending."
      : "This file could not be opened as a PDF, so no fields were placed. Upload the agreement again, or export it to PDF first.";
    return { pdf, pages, fields, meta: meta("none", true, [note]) };
  }
}

export async function detectFields(pdf: Uint8Array, options?: DetectOptions): Promise<DetectionResult> {
  return detectFieldsWith(pdf, options ?? {}, {});
}
