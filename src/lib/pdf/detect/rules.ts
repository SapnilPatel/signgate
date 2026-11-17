/**
 * Rule-based detection: reads the geometry of the page the way a person does.
 * A blank is labelled by the words to its left, under it or above it; labelled
 * blanks that sit together form a signature block; a block belongs to whichever
 * party its heading or labels name.
 */
import type { Field, FieldRole, FieldType, MergeKey } from "@/lib/types";
import { newId } from "@/lib/ids";
import { clampRect } from "../geometry";
import { piecesInCell, rectFor, renderLine, type Blank, type Cell, type Line, type Model, type Piece } from "./layout";
import {
  classifyBodyBlank,
  classifyLabel,
  findDefinedTerms,
  isPartyHeading,
  isSigningMarker,
  isWitnessHeading,
  normalize,
  partyOf,
  wordCount,
  type DefinedTerms,
  type LabelKind,
  type PartyMatch,
} from "./labels";

/** The words that identify the parties in this particular document. */
interface Vocabulary {
  companyName?: string;
  terms?: DefinedTerms;
}

/** Thrown when the rules run out of time; the caller falls back to a result that can still be signed. */
export class DetectionTimeout extends Error {
  constructor() {
    super("Field detection ran out of time.");
    this.name = "DetectionTimeout";
  }
}

export interface RuleOptions {
  /** Epoch milliseconds after which detection gives up with DetectionTimeout. */
  deadline?: number;
}

/** Labels with nothing printed after them that are considered, per page and in total. */
const MAX_IMPLICIT_PER_PAGE = 60;
const MAX_IMPLICIT_TOTAL = 600;
const MAX_CELL_FIELDS = 300;

type Kind = LabelKind | "unlabeled";

interface Candidate {
  blank: Blank;
  kind: Kind;
  party: PartyMatch | null;
  labelFrom: "left" | "under" | "above" | "form" | "none";
  /** Leftmost extent of the blank together with its label; decides which column it is in. */
  labelX0: number;
  /** No line is printed: the field sits in the empty space after a label. */
  implicit: boolean;
  inZone: boolean;
  /** The label as printed, when one typed the blank. */
  labelText?: string;
}

interface Cluster {
  page: number;
  cands: Candidate[];
  /** x that separates two side-by-side blocks, when the band has two columns. */
  split?: number;
  column: 0 | 1;
  party: PartyMatch | null;
  role?: "client" | "company";
  guessed?: boolean;
}

/** What a heading over a block says: whose block it is, or that it is for a witness or notary. */
type Heading = PartyMatch | "witness";

/** What produced a field, kept so a later pass can re-place or re-type it from real geometry. */
export interface FieldOrigin {
  blank: Blank;
  lineId: string;
  context: string;
}

export interface RuleResult {
  fields: Field[];
  origins: Map<string, FieldOrigin>;
  model: Model;
  stats: {
    signatureBlocks: number;
    clientSignatures: number;
    companySignatures: number;
    guessedRoles: boolean;
    prefills: number;
    openBlanks: number;
    initials: number;
    witnessLines: number;
    /** Blanks left out because the document has more than the rules consider. */
    skippedBlanks: number;
  };
}

const ROLE_LABELS: Record<"client" | "company", Partial<Record<FieldType, string>>> = {
  client: {
    signature: "Client signature",
    initials: "Client initials",
    full_name: "Client name",
    title: "Client title",
    company: "Client company",
    email: "Client email",
    date_signed: "Client signing date",
    text: "Client details",
  },
  company: {
    signature: "Company signature",
    initials: "Company initials",
    full_name: "Company signer name",
    title: "Company signer title",
    company: "Company name",
    email: "Company signer email",
    date_signed: "Company signing date",
    text: "Company details",
  },
};

export function labelFor(role: FieldRole, type: FieldType, fallback: string): string {
  if (role === "prefill") return fallback;
  return ROLE_LABELS[role][type] ?? fallback;
}

const stripEnumerator = (text: string) => text.replace(/^\s*(?:\(?[0-9a-zA-Z]{1,3}[.)]|[•●■*-])\s+/, "");
const endsWithColon = (text: string) => /[:：]\s*$/.test(text);

function leftPiece(blank: Blank): Piece | null {
  const pieces = blank.line.pieces;
  const index = pieces.findIndex((p) => p.blank === blank);
  let at = index - 1;
  // A form widget often sits on top of a printed underscore line; look past it to the label.
  while (at >= 0 && pieces[at].kind === "blank" && pieces[at].x1 > blank.x0 + 2) at--;
  const prev = at >= 0 ? pieces[at] : null;
  if (!prev || prev.kind !== "text") return null;
  // A label and its line are often tab-separated; plain prose sits right next to its blank.
  const reach = endsWithColon(prev.text) ? 170 : 3.2 * blank.line.size;
  return blank.x0 - prev.x1 <= reach ? prev : null;
}

function labelsABlank(line: Line, piece: Piece): boolean {
  const index = line.pieces.indexOf(piece);
  const next = line.pieces[index + 1];
  return Boolean(next && next.kind === "blank" && next.blank && leftPiece(next.blank) === piece);
}

/** A caption printed right after a blank: "__________ (Signature)" or "__________ Date". */
function rightPiece(blank: Blank): Piece | null {
  const pieces = blank.line.pieces;
  const index = pieces.findIndex((p) => p.blank === blank);
  const next = index >= 0 ? pieces[index + 1] : null;
  if (!next || next.kind !== "text" || next.x0 - blank.x1 > 2.5 * blank.line.size) return null;
  const following = pieces[index + 2];
  // Only a caption that closes the row, or one in brackets, describes the blank before it.
  return /^\s*[([].*[)\]]\s*$/.test(next.text) || !following ? next : null;
}

/** Text printed just under a blank ("______" over "Client Signature"). */
function underPieces(model: Model, blank: Pick<Blank, "page" | "x0" | "x1" | "y">): { line: Line; pieces: Piece[] } | null {
  for (const line of model.linesByPage[blank.page]) {
    if (line.synthetic || line.baseline <= blank.y + 0.45 * line.size) continue;
    if (line.baseline > blank.y + 2.4 * line.size) break;
    const pieces = line.pieces.filter((p) => {
      // "Name:" under a line is the start of the next row, not a caption for the line above.
      if (p.kind !== "text" || labelsABlank(line, p) || endsWithColon(p.text)) return false;
      const overlap = Math.min(p.x1, blank.x1 + 6) - Math.max(p.x0, blank.x0 - 6);
      return overlap >= 0.3 * (p.x1 - p.x0) && p.x0 >= blank.x0 - 0.5 * (p.x1 - p.x0);
    });
    // Only the line directly below can be a caption; anything further is other content.
    if (line.pieces.some((p) => p.x1 > blank.x0 && p.x0 < blank.x1)) return pieces.length ? { line, pieces } : null;
  }
  return null;
}

/** A label printed alone on the line above a blank ("Signature:" then a line underneath). */
function abovePiece(model: Model, blank: Blank): Piece | null {
  const lines = model.linesByPage[blank.page];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.baseline >= blank.y - 0.6 * blank.size) continue;
    if (line.baseline < blank.y - 3 * Math.max(blank.size, line.size)) break;
    const overlapping = line.pieces.filter((p) => p.x1 > blank.x0 - 4 && p.x0 < blank.x1);
    if (!overlapping.length) continue;
    const piece = overlapping[0];
    return overlapping.length === 1 && piece.kind === "text" && !labelsABlank(line, piece) ? piece : null;
  }
  return null;
}

function contextAround(model: Model, blank: Blank): { left: string; right: string } {
  const lines = model.linesByPage[blank.page];
  const li = lines.indexOf(blank.line);
  const pieces = blank.line.pieces;
  const index = pieces.findIndex((p) => p.blank === blank);
  const show = (p: Piece) => (p.kind === "blank" ? "____" : p.text);
  let left = pieces.slice(0, Math.max(0, index)).map(show).join(" ");
  if (left.length < 28 && li > 0) {
    const prev = lines[li - 1];
    if (!prev.synthetic && blank.line.baseline - prev.baseline <= 2.4 * Math.max(prev.size, blank.line.size)) left = `${prev.pieces.map(show).join(" ")} ${left}`;
  }
  const after = index >= 0 ? pieces.slice(index + 1) : [];
  let right = "";
  let hitBlank = false;
  for (const p of after) {
    if (p.kind === "blank") {
      hitBlank = true;
      right += " ____";
      break;
    }
    right += ` ${p.text}`;
  }
  // A sentence that runs on to the next line carries its meaning there ("____, with its
  // principal place of business / at ____ ("Client")"), so an unfinished one is read on.
  const unfinished = right.trim().length < 14 || (right.trim().length < 70 && !/[.;:!?]/.test(right));
  if (!hitBlank && unfinished && li >= 0 && li + 1 < lines.length) {
    const next = lines[li + 1];
    if (!next.synthetic && next.baseline - blank.line.baseline <= 2.4 * Math.max(next.size, blank.line.size)) right += ` ${next.pieces.map(show).join(" ")}`;
  }
  return { left, right };
}

/** A label that asks for an organization's name without saying whose. */
const BARE_ORGANIZATION = /^(the )?(company|organi[sz]ation|business|firm|employer)( name)?$/;

function kindClass(kind: Kind): string {
  return kind === "signature" || kind === "unlabeled" || kind === "party" ? "sig" : kind;
}

function formKind(type: FieldType): LabelKind | null {
  switch (type) {
    case "signature":
      return "signature";
    case "initials":
      return "initials";
    case "date_signed":
      return "date";
    case "full_name":
    case "title":
    case "company":
    case "email":
      return type;
    default:
      return null;
  }
}

/** Words that end a clause, not a label: "... (\"Company\") and ____" is a sentence with a blank in it. */
const TRAILING_CONNECTIVE = /(?:^|[\s,;])(?:and|or|between|with|to|from|that|is|are|as|&)\s*$/i;
const QUOTED_DEFINITION = /\([^()]{0,60}["“”][^()]{0,60}\)/;
/** A defined term right after a blank: '____ ("Client")', '____ (hereinafter the "Customer")'. */
const DEFINITION_AFTER = /^\s*,?\s*\(([^()"“”]{0,60})["“]\s*([^"“”()]{2,32}?)\s*["”]/;

/** False for text that reads as the end of a clause rather than as the label of the blank after it. */
function labelShaped(text: string): boolean {
  if (endsWithColon(text)) return true;
  return !TRAILING_CONNECTIVE.test(text) && !QUOTED_DEFINITION.test(text);
}

/** The opening pages as running text, for reading how the agreement names its parties. */
function openingText(model: Model): string {
  let out = "";
  for (const line of model.lines) {
    if (line.page > 2 || out.length > 40_000) break;
    if (line.synthetic) continue;
    out += `${line.pieces.map((p) => (p.kind === "blank" ? "____" : p.text)).join(" ")} `;
  }
  return out.replace(/\s+/g, " ");
}

export function detectByRules(model: Model, companyName?: string, options: RuleOptions = {}): RuleResult {
  const fields: Field[] = [];
  const origins = new Map<string, FieldOrigin>();
  const stats = { signatureBlocks: 0, clientSignatures: 0, companySignatures: 0, guessedRoles: false, prefills: 0, openBlanks: 0, initials: 0, witnessLines: 0, skippedBlanks: model.skippedBlanks ?? 0 };
  const pageCount = model.pages.length;
  const consumed = new Set<Piece>();
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let ticks = 0;
  // Checked in every loop that grows with the document, so a pathological file is cut off instead of running for minutes.
  const tick = () => {
    if ((++ticks & 31) === 0 && Date.now() > deadline) throw new DetectionTimeout();
  };
  const vocab: Vocabulary = { companyName, terms: findDefinedTerms(openingText(model), companyName) };
  const label = (text: string) => classifyLabel(text, vocab.companyName, vocab.terms);
  const lineIndex = new Map<Line, number>();
  model.linesByPage.forEach((lines) => lines.forEach((line, i) => lineIndex.set(line, i)));

  // Running headers and footers: the same words at the same height in the margin of two or more
  // pages ("Astra AI, LLC - Confidential", "Page 3 of 9"). They name no block and are not body text.
  const furniture = new Set<Line>();
  if (pageCount > 1) {
    const seenAt = new Map<string, Line[]>();
    for (const line of model.lines) {
      const height = model.pages[line.page].height;
      if (line.synthetic || (line.baseline > 0.12 * height && line.baseline < 0.88 * height)) continue;
      const key = `${Math.round(line.baseline / 4)}:${normalize(renderLine(line)).replace(/\d+/g, "#")}`;
      const list = seenAt.get(key);
      if (list) list.push(line);
      else seenAt.set(key, [line]);
    }
    for (const list of seenAt.values()) if (new Set(list.map((l) => l.page)).size > 1) for (const line of list) furniture.add(line);
  }

  // Where each page's signing section starts, if it announces one.
  const markerY: (number | null)[] = model.pages.map(() => null);
  for (const line of model.lines) {
    if (!line.synthetic && markerY[line.page] === null && isSigningMarker(renderLine(line))) markerY[line.page] = line.baseline;
  }
  const inZone = (page: number, y: number) => {
    const here = markerY[page];
    if (here !== null && here !== undefined && y >= here - 2) return true;
    const before = page > 0 ? markerY[page - 1] : null;
    return before !== null && before !== undefined;
  };
  const lateInDocument = (page: number, y: number) => (pageCount > 1 ? page >= Math.floor(pageCount / 2) : y > 0.45 * model.pages[page].height);

  const emit = (
    blank: Blank,
    type: FieldType,
    role: FieldRole,
    required: boolean,
    label: string,
    confidence: number,
    mergeKey?: MergeKey,
  ) => {
    const form = blank.form;
    const rect = form ? clampRect(form) : clampRect(rectFor(model, blank, type));
    if (!(rect.w > 0 && rect.h > 0)) return;
    const field: Field = {
      id: form?.id || newId("fld"),
      page: blank.page,
      ...rect,
      type,
      role,
      required,
      label: label.slice(0, 80),
      source: form ? "form" : "detected",
      confidence: Math.round(Math.min(0.99, Math.max(0.05, confidence)) * 100) / 100,
    };
    if (role === "prefill" && mergeKey) field.mergeKey = mergeKey;
    fields.push(field);
    const ctx = contextAround(model, blank);
    origins.set(field.id, { blank, lineId: blank.line.id, context: `${ctx.left.slice(-80)} [HERE] ${ctx.right.slice(0, 60)}`.trim() });
  };

  const emitBody = (blank: Blank) => {
    const ctx = contextAround(model, blank);
    let match = classifyBodyBlank(ctx.left, ctx.right);
    // What the agreement itself calls the party named right after the blank outranks the generic words.
    const defined = vocab.terms ? DEFINITION_AFTER.exec(ctx.right) : null;
    if (defined && vocab.terms && !match.settled) {
      const term = normalize(defined[2]).replace(/^the /, "");
      if (vocab.terms.client.includes(term)) match = { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.8 };
      else if (vocab.terms.sender.includes(term)) match = { type: "company", role: "prefill", mergeKey: "company_name", label: "Company name", confidence: 0.7 };
    }
    const form = blank.form;
    if (form && match.confidence <= 0.4) {
      // Nothing on the page says more than the form itself did; keep what ingest decided.
      emit(blank, form.type, form.role, form.required, form.label || "Form field", 0.6, form.mergeKey);
      return;
    }
    const label = match.label || form?.label || `Fill-in on page ${blank.page + 1}`;
    emit(blank, match.type, match.role, false, label, match.confidence, match.mergeKey);
    if (match.role === "prefill") stats.prefills++;
    else stats.openBlanks++;
  };

  // ---- 1. Label every blank -------------------------------------------------
  const block: Candidate[] = [];
  const initials: Candidate[] = [];
  const derived = (blank: Blank, x0: number, x1: number, n: number): Blank => ({ ...blank, id: `${blank.id}.${n}`, x0, x1 });
  /** A party's name printed under a labelled signature line; whether it captions that line is decided once every line is known. */
  const pendingCaptions: { cand: Candidate; piece: Piece; line: Line; party: PartyMatch }[] = [];

  for (const blank of model.blanks) {
    tick();
    const form = blank.form;
    if (form?.type === "checkbox") {
      const ctx = contextAround(model, blank);
      const party = partyOf(`${form.label} ${ctx.left.slice(-40)} ${ctx.right.slice(0, 40)}`, companyName, vocab.terms);
      const role = party?.party === "company" && party.strength >= 3 ? "company" : form.role === "prefill" ? "client" : form.role;
      emit(blank, "checkbox", role, false, form.label || "Checkbox", 0.7);
      continue;
    }
    if (blank.source === "dots") {
      // Leaders that run into more text ("Fees ........ 4") are a table of contents or a price list.
      const pieces = blank.line.pieces;
      if (pieces[pieces.findIndex((p) => p.blank === blank) + 1]?.kind === "text") continue;
    }
    const left = leftPiece(blank);
    const leftText = left ? stripEnumerator(left.text) : "";
    const pieceIndex = blank.line.pieces.findIndex((p) => p.blank === blank);
    const following = pieceIndex >= 0 ? blank.line.pieces[pieceIndex + 1] : undefined;
    // '(\"Company\") and ____ (\"Client\")': the words before the blank end a clause and a definition follows it.
    // That is a sentence with a blank in it, however short the text on this line happens to be.
    const definedAfter = following?.kind === "text" && DEFINITION_AFTER.test(following.text);
    let leftMatch = left && wordCount(leftText) <= 6 && labelShaped(leftText) && !definedAfter ? label(leftText) : null;
    if (left && !leftMatch) {
      // "... agrees to the terms above. Signature: ____": a label at the end of a sentence.
      const tail = /((?:[\p{L}'’]+\s+){0,2}(?:signature|signed by|sign here|signed|initials?))\s*:\s*$/iu.exec(leftText);
      if (tail && wordCount(leftText) > 6) leftMatch = label(tail[1]);
    }
    // A caption underneath only counts for a blank that stands on its own: inside a
    // sentence, the text below is just the next line of the paragraph.
    const inProse = Boolean(left) && !leftMatch;
    const under = inProse || (leftMatch && leftMatch.kind !== "party") ? null : underPieces(model, blank);
    const above = left ? null : abovePiece(model, blank);
    const right = left ? null : rightPiece(blank);
    // A bare party word after a blank is a definition ('____ (the "Client")'), which the body rules read.
    const rightRead = right && wordCount(right.text) <= 5 ? label(right.text) : null;
    const rightMatch = rightRead && rightRead.kind !== "party" ? rightRead : null;
    const aboveMatch = above && wordCount(above.text) <= 6 ? label(above.text) : null;

    const formMatch = form ? (formKind(form.type) ? { kind: formKind(form.type)!, party: partyOf(form.label, companyName, vocab.terms) } : label(form.label)) : null;

    // One long line captioned underneath in several places ("Signature        Date") is several blanks.
    const underMatches = (under?.pieces ?? [])
      .map((piece) => ({ piece, match: wordCount(piece.text) <= 7 ? label(piece.text) : null }))
      .filter((u) => u.match);
    const parts: { blank: Blank; underMatch: ReturnType<typeof classifyLabel>; underPiece?: Piece }[] = [];
    if (!form && underMatches.length > 1) {
      underMatches.forEach((u, i) => {
        const x0 = i === 0 ? blank.x0 : Math.max(blank.x0, u.piece.x0);
        const x1 = i + 1 < underMatches.length ? Math.min(blank.x1, underMatches[i + 1].piece.x0 - 10) : blank.x1;
        if (x1 - x0 >= 24) parts.push({ blank: derived(blank, x0, x1, i + 1), underMatch: u.match, underPiece: u.piece });
      });
    }
    if (!parts.length) parts.push({ blank, underMatch: underMatches[0]?.match ?? null, underPiece: underMatches[0]?.piece });

    for (const part of parts) {
      const ordered: { match: NonNullable<ReturnType<typeof classifyLabel>>; from: Candidate["labelFrom"]; piece?: Piece }[] = [];
      if (formMatch) ordered.push({ match: formMatch, from: "form" });
      if (leftMatch && left) ordered.push({ match: leftMatch, from: "left", piece: left });
      if (part.underMatch) ordered.push({ match: part.underMatch, from: "under", piece: part.underPiece });
      if (rightMatch && right) ordered.push({ match: rightMatch, from: "under", piece: right });
      if (aboveMatch && above) ordered.push({ match: aboveMatch, from: "above", piece: above });

      const typed = ordered.find((o) => o.match.kind !== "party") ?? ordered[0];
      const partySource = ordered.find((o) => o.match.party);
      const zone = inZone(part.blank.page, part.blank.y);
      const labelX0 = left && typed?.from === "left" ? left.x0 : part.blank.x0;

      if (!typed) {
        const span = part.blank.x1 - part.blank.x0;
        // A line across the whole text column is a separator or a write-in area, not a place to sign.
        const wide = span >= 70 && span <= 0.7 * model.pages[part.blank.page].width;
        const hasProse = Boolean(left) || part.blank.line.pieces.some((p) => p.kind === "text");
        if (part.blank.source === "dots") continue; // table-of-contents leaders and decorative rows
        if (part.blank.source === "rule" && !(left && endsWithColon(left.text))) {
          // An unlabelled drawn line may still be the place to sign; anything else drawn is decoration.
          if (!left && wide) block.push({ blank: part.blank, kind: "unlabeled", party: null, labelFrom: "none", labelX0, implicit: false, inZone: zone });
          continue;
        }
        if (hasProse || form) emitBody(part.blank);
        else if (wide) block.push({ blank: part.blank, kind: "unlabeled", party: null, labelFrom: "none", labelX0, implicit: false, inZone: zone });
        continue;
      }
      // A line across the whole text column with only a party's name under it is a separator above
      // a heading or a footer ("Astra AI, LLC - Confidential"), not that party's signature line.
      if (part.blank.fullWidth && !form && ordered.every((o) => o.match.kind === "party")) continue;
      for (const o of ordered) if (o.piece) consumed.add(o.piece);
      if (typed.match.kind === "witness") {
        stats.witnessLines++;
        continue;
      }
      const cand: Candidate = { blank: part.blank, kind: typed.match.kind, party: partySource?.match.party ?? null, labelFrom: typed.from, labelX0, implicit: false, inZone: zone, labelText: typed.piece?.text };
      if (cand.kind === "initials") initials.push(cand);
      else block.push(cand);

      // "By: ______" with "Client" printed on the next line. The name may caption this line or
      // head the block below it; remember it and decide when the whole page is known.
      if (cand.kind === "signature" && typed.from === "left" && left && !cand.party && !form) {
        const below = underPieces(model, { page: blank.page, x0: left.x0, x1: blank.x1, y: blank.y });
        const named = below?.pieces.find((p) => !consumed.has(p) && wordCount(p.text) <= 7 && label(p.text)?.kind === "party");
        const party = named ? label(named.text)?.party : null;
        if (below && named && party) pendingCaptions.push({ cand, piece: named, line: below.line, party });
      }
    }
  }

  // A name under a labelled signature line captions that line when it sits closer to it than to
  // what follows, when what follows is not another place to sign, or when the last signature line
  // of the column has such a name too (a heading would have nothing under it to head).
  if (pendingCaptions.length) {
    const signLines = block.filter((c) => c.kind === "signature" || c.kind === "unlabeled");
    const sameColumn = (a: Candidate, b: Candidate) => a.blank.page === b.blank.page && Math.min(a.blank.x1, b.blank.x1) - Math.max(a.labelX0, b.labelX0) > 0;
    const captioned = new Set(pendingCaptions.map((p) => p.cand));
    for (const pending of pendingCaptions) {
      tick();
      const { cand, line } = pending;
      const lines = model.linesByPage[cand.blank.page];
      let next: Line | undefined;
      for (let i = (lineIndex.get(line) ?? lines.length) + 1; i < lines.length; i++) {
        if (lines[i].pieces.some((p) => p.x1 > cand.labelX0 && p.x0 < cand.blank.x1)) {
          next = lines[i];
          break;
        }
      }
      const gapAbove = line.baseline - cand.blank.y;
      const gapBelow = next ? next.baseline - line.baseline : Number.POSITIVE_INFINITY;
      const nextSigns = Boolean(next) && signLines.some((c) => c !== cand && c.blank.line === next && sameColumn(c, cand));
      const column = signLines.filter((c) => sameColumn(c, cand));
      const last = column.sort((a, b) => b.blank.y - a.blank.y)[0];
      if (gapBelow >= 1.25 * gapAbove || !nextSigns || (last && captioned.has(last))) {
        cand.party = pending.party;
        consumed.add(pending.piece);
      }
    }
  }

  // ---- 1b. Labels in bordered tables ------------------------------------------
  // Word-style signature tables: the borders are cell edges, and the place to write is the
  // empty cell next to (or under) a label, or the empty part of the label's own cell.
  const cellKey = (c: Cell) => `${c.page}:${Math.round(c.x0)}:${Math.round(c.y0)}:${Math.round(c.x1)}:${Math.round(c.y1)}`;
  const seenCells = new Set<string>();
  const emptyCells = new Set<string>();
  let cellFields = 0;
  const isEmptyCell = (cell: Cell | null, from: Cell): cell is Cell => {
    if (!cell || cellKey(cell) === cellKey(from) || emptyCells.has(cellKey(cell))) return false;
    return piecesInCell(model, cell).length === 0;
  };
  const shortCells: { cell: Cell; pieces: Piece[]; cand: Candidate }[] = [];
  const signatureCells: Blank[] = [];
  for (const line of model.lines) {
    if (line.synthetic || cellFields >= MAX_CELL_FIELDS) continue;
    for (const piece of line.pieces) {
      tick();
      if (piece.kind !== "text" || consumed.has(piece) || wordCount(piece.text) > 6) continue;
      const cell = model.cellAt(line.page, (piece.x0 + piece.x1) / 2, line.baseline - 0.3 * line.size);
      if (!cell || seenCells.has(cellKey(cell))) continue;
      seenCells.add(cellKey(cell));
      const inside = piecesInCell(model, cell);
      // Underscores or a drawn line inside the cell already say where to write; the usual rules read those.
      if (inside.some((p) => p.piece.kind === "blank") || inside.length > 3) continue;
      const text = stripEnumerator(inside.map((p) => p.piece.text).join(" "));
      const match = wordCount(text) <= 6 ? label(text) : null;
      if (!match) continue;
      if (match.kind === "witness") {
        for (const p of inside) consumed.add(p.piece);
        stats.witnessLines++;
        continue;
      }
      const pad = 3;
      const lastLine = inside[inside.length - 1].line;
      const textRight = Math.max(...inside.map((p) => p.piece.x1));
      const midY = (cell.y0 + cell.y1) / 2;
      const midX = (cell.x0 + cell.x1) / 2;
      const right = model.cellAt(line.page, cell.x1 + 8, midY);
      const below = model.cellAt(line.page, midX, cell.y1 + 6);
      const spaceBelow = cell.y1 - (lastLine.baseline + 0.25 * lastLine.size);
      const colon = endsWithColon(text);
      const whole = (target: Cell, top: number): Blank => ({ id: `c-${line.id}-${Math.round(target.x0)}`, page: line.page, line: lastLine, x0: target.x0 + pad, x1: target.x1 - pad, y: target.y1 - pad, size: lastLine.size, source: "cell", top });
      let blank: Blank | null = null;
      let kind: Kind = match.kind;
      if (isEmptyCell(right, cell)) {
        blank = whole(right, right.y0 + 1);
        emptyCells.add(cellKey(right));
      } else if (spaceBelow >= (match.kind === "party" ? 30 : 18)) {
        // A small label at the top of a tall cell: the rest of the cell is where to write.
        blank = whole(cell, lastLine.baseline + 0.3 * lastLine.size);
        // A tall empty cell under a party's name is that party's place to sign.
        if (match.kind === "party") kind = "signature";
      } else if (colon && match.kind !== "party" && cell.x1 - pad - (textRight + 5) >= 50) {
        blank = { id: `c-${line.id}-${Math.round(cell.x0)}`, page: line.page, line: lastLine, x0: textRight + 5, x1: cell.x1 - pad, y: Math.min(cell.y1 - 1, lastLine.baseline + 0.12 * lastLine.size), size: lastLine.size, source: "cell", top: cell.y0 + 1 };
      } else if (isEmptyCell(below, cell)) {
        // A column heading over one empty row ("Signature | Date" above a row to fill in).
        // Further empty rows make it a sign-in sheet, which is nobody's signature block.
        const further = model.cellAt(line.page, midX, below.y1 + 6);
        if (!further || piecesInCell(model, further).length > 0) {
          blank = whole(below, below.y0 + 1);
          emptyCells.add(cellKey(below));
        }
      }
      if (!blank && !colon && (kind === "full_name" || kind === "date" || kind === "title" || kind === "company") && cell.x1 - pad - (textRight + 8) >= 70) {
        // A short cell with its label in the corner and nothing else ("Full name", "Date").
        // On its own that is a column heading; under a signature cell it is that signer's line.
        const beside: Blank = { id: `c-${line.id}-${Math.round(cell.x0)}`, page: line.page, line: lastLine, x0: textRight + 8, x1: cell.x1 - pad, y: cell.y1 - pad, size: lastLine.size, source: "cell", top: cell.y0 + 1 };
        shortCells.push({ cell, pieces: inside.map((p) => p.piece), cand: { blank: beside, kind, party: match.party, labelFrom: "left", labelX0: Math.min(...inside.map((p) => p.piece.x0)), implicit: false, inZone: inZone(line.page, beside.y), labelText: text } });
        continue;
      }
      if (!blank || blank.x1 - blank.x0 < 24) continue;
      for (const p of inside) consumed.add(p.piece);
      cellFields++;
      const cand: Candidate = { blank, kind, party: match.party, labelFrom: "left", labelX0: Math.min(...inside.map((p) => p.piece.x0)), implicit: false, inZone: inZone(line.page, blank.y), labelText: text };
      if (cand.kind === "initials") initials.push(cand);
      else block.push(cand);
      if (cand.kind === "signature" && blank.source === "cell") signatureCells.push(blank);
    }
  }

  for (const short of shortCells) {
    if (cellFields >= MAX_CELL_FIELDS) break;
    const { cell } = short;
    const under = signatureCells.some((sig) => sig.page === cell.page && sig.x0 >= cell.x0 - 1 && sig.x1 <= cell.x1 + 1 && sig.y <= cell.y0 + 2 && cell.y0 - sig.y <= 160);
    if (!under) continue;
    for (const piece of short.pieces) consumed.add(piece);
    cellFields++;
    block.push(short.cand);
  }

  // Three or more identical unlabelled lines stacked together are a write-in area
  // ("Comments: ____ / ____ / ____"), never a place to sign.
  const loose = block.filter((c) => c.kind === "unlabeled");
  const writeIn = new Set<Candidate>();
  for (const cand of loose) {
    const stack = loose.filter((o) => o.blank.page === cand.blank.page && Math.abs(o.blank.x0 - cand.blank.x0) < 4 && Math.abs(o.blank.x1 - cand.blank.x1) < 4 && Math.abs(o.blank.y - cand.blank.y) <= 80);
    if (stack.length >= 3) for (const member of stack) writeIn.add(member);
  }
  if (writeIn.size) block.splice(0, block.length, ...block.filter((c) => !writeIn.has(c)));

  // ---- 2. Labels with nothing printed after them ("Signature:" then empty space)
  const implicitOnPage: number[] = model.pages.map(() => 0);
  let implicitTotal = 0;
  for (const line of model.lines) {
    if (line.synthetic) continue;
    line.pieces.forEach((piece, index) => {
      tick();
      if (piece.kind !== "text" || consumed.has(piece) || !endsWithColon(piece.text)) return;
      if (implicitOnPage[line.page] >= MAX_IMPLICIT_PER_PAGE || implicitTotal >= MAX_IMPLICIT_TOTAL) return;
      const text = stripEnumerator(piece.text);
      if (wordCount(text) > 4) return;
      const match = label(text);
      if (!match || match.kind === "witness" || match.kind === "party") return;
      // "Client signature:" printed over an empty drawn box: the box is the place to write.
      const boxed = model.cellAt(line.page, piece.x0 + 8, line.baseline + 1.3 * line.size + 4);
      if (boxed && boxed.y0 > line.baseline - 1 && boxed.y0 - line.baseline <= 2.2 * line.size && boxed.x1 - boxed.x0 >= 60 && !emptyCells.has(cellKey(boxed)) && piecesInCell(model, boxed).length === 0) {
        emptyCells.add(cellKey(boxed));
        const inBox: Blank = { id: `c-${line.id}-${index}`, page: line.page, line, x0: boxed.x0 + 3, x1: boxed.x1 - 3, y: boxed.y1 - 3, size: line.size, source: "cell", top: boxed.y0 + 1 };
        const cand: Candidate = { blank: inBox, kind: match.kind, party: match.party, labelFrom: "above", labelX0: piece.x0, implicit: false, inZone: inZone(line.page, inBox.y), labelText: text };
        consumed.add(piece);
        if (cand.kind === "initials") initials.push(cand);
        else block.push(cand);
        return;
      }
      const next = line.pieces[index + 1];
      const pageWidth = model.pages[line.page].width;
      const x0 = piece.x1 + 5;
      const x1 = Math.min(next ? next.x0 - 10 : Number.POSITIVE_INFINITY, x0 + 220, pageWidth - 30);
      if (x1 - x0 < 60) return;
      const blank: Blank = { id: `s-${line.id}-${index}`, page: line.page, line, x0, x1, y: line.baseline + 0.12 * line.size, size: line.size, source: "space" };
      const cand: Candidate = { blank, kind: match.kind, party: match.party, labelFrom: "left", labelX0: piece.x0, implicit: true, inZone: inZone(line.page, blank.y), labelText: text };
      implicitOnPage[line.page]++;
      implicitTotal++;
      if (cand.kind === "initials") initials.push(cand);
      else block.push(cand);
    });
  }

  // ---- 3. Group labelled blanks into blocks --------------------------------
  const clusters: Cluster[] = [];
  for (let page = 0; page < pageCount; page++) {
    const onPage = block.filter((c) => c.blank.page === page).sort((a, b) => a.blank.y - b.blank.y || a.blank.x0 - b.blank.x0);
    if (!onPage.length) continue;
    const bands: Candidate[][] = [];
    for (const cand of onPage) {
      const band = bands[bands.length - 1];
      if (band && cand.blank.y - band[band.length - 1].blank.y <= 120) band.push(cand);
      else bands.push([cand]);
    }
    for (const band of bands) {
      // Two blanks of the same kind on one row means two parties side by side.
      const splits: number[] = [];
      const rows: Candidate[][] = [];
      for (const cand of band) {
        const row = rows[rows.length - 1];
        if (row && Math.abs(cand.blank.y - row[0].blank.y) < 5) row.push(cand);
        else rows.push([cand]);
      }
      for (const row of rows) {
        const sorted = row.slice().sort((a, b) => a.blank.x0 - b.blank.x0);
        for (let i = 1; i < sorted.length; i++) {
          const twin = sorted.slice(0, i).reverse().find((c) => kindClass(c.kind) === kindClass(sorted[i].kind));
          if (twin) {
            splits.push((twin.blank.x1 + sorted[i].labelX0) / 2);
            break;
          }
        }
      }
      const split = splits.length ? splits.sort((a, b) => a - b)[Math.floor(splits.length / 2)] : undefined;
      const columns: Candidate[][] = split === undefined ? [band] : [band.filter((c) => (c.labelX0 + c.blank.x1) / 2 < split), band.filter((c) => (c.labelX0 + c.blank.x1) / 2 >= split)];
      columns.forEach((column, columnIndex) => {
        let current: Cluster | null = null;
        let prev: Candidate | null = null;
        for (const cand of column.slice().sort((a, b) => a.blank.y - b.blank.y || a.blank.x0 - b.blank.x0)) {
          tick();
          // "Signature: ____ / Name: ____ / Company: ____" in one stack: the bare "Company" row asks which
          // organization the signer is from. It is a detail of that block, not a second party's place to sign.
          if (
            current !== null &&
            cand.kind === "party" &&
            cand.labelFrom === "left" &&
            cand.party?.party === "company" &&
            cand.party.strength === 1 &&
            BARE_ORGANIZATION.test(normalize(cand.labelText ?? "")) &&
            current.cands.some((c) => c.kind === "signature") &&
            !current.cands.some((c) => c.kind === "company")
          ) {
            cand.kind = "company";
            cand.party = null;
          }
          const cls = kindClass(cand.kind);
          const repeats = current !== null && ["sig", "full_name", "date", "title"].includes(cls) && current.cands.some((c) => kindClass(c.kind) === cls);
          const partyChange = current !== null && cand.party !== null && cand.kind !== "party" && current.cands.some((c) => c.party && c.kind !== "party" && c.party.party !== cand.party!.party);
          const headingBetween = prev !== null && headingIn(model, page, prev.blank.y + 2, cand.blank.y - 0.9 * cand.blank.size - 2, split, columnIndex as 0 | 1, consumed, vocab) !== null;
          if (!current || repeats || partyChange || headingBetween) {
            current = { page, cands: [], split, column: columnIndex as 0 | 1, party: null };
            clusters.push(current);
          }
          current.cands.push(cand);
          prev = cand;
        }
      });
    }
  }

  // ---- 4. Decide what each block is and whose it is -------------------------
  // Several unlabelled lines under one heading are a write-in area; at most the first is a signature.
  const promoted = new Set<string>();
  for (const cluster of clusters) {
    tick();
    const own = cluster.cands.filter((c) => c.party && c.kind !== "party").sort((a, b) => b.party!.strength - a.party!.strength)[0]?.party ?? null;
    const first = cluster.cands[0];
    const found = own ? null : headingAbove(model, cluster, clusters, consumed, vocab, furniture);
    if (found === "witness") {
      // Everything under a WITNESS or NOTARY heading is for someone who is not a party to the envelope.
      cluster.cands = [];
      stats.witnessLines++;
      continue;
    }
    const heading = found;
    const partyOnly = cluster.cands.find((c) => c.kind === "party")?.party ?? null;
    cluster.party = own ?? heading ?? partyOnly;

    if (!cluster.cands.some((c) => c.kind === "signature")) {
      const others = cluster.cands.some((c) => c.kind !== "unlabeled" && c.kind !== "party");
      const unlabeled = cluster.cands.find((c) => c.kind === "unlabeled");
      const named = cluster.cands.find((c) => c.kind === "party");
      const key = `${cluster.page}:${cluster.column}:${cluster.party?.party ?? "none"}`;
      if (unlabeled && (others || ((heading || first.inZone) && !promoted.has(key)))) {
        unlabeled.kind = "signature";
        promoted.add(key);
      }
      else if (named && (named.labelFrom === "under" || named.inZone || (others && lateInDocument(cluster.page, named.blank.y)))) named.kind = "signature";
    }
    cluster.cands = cluster.cands.filter((c) => c.kind !== "unlabeled");
  }

  const isSigningCluster = (c: Cluster) => c.cands.some((k) => k.kind === "signature");

  // A block cut in two by a page break: "By / Name" at the foot of one page and "Title / Date"
  // at the head of the next. The continuation has no heading and no signature of its own, so on
  // its own it would read as a details panel and be filled in with the client's data.
  const DETAIL_KINDS: Kind[] = ["full_name", "title", "date", "company", "email", "phone", "address"];
  const isFurniture = (line: Line) => {
    const height = model.pages[line.page].height;
    return furniture.has(line) || line.baseline < 0.07 * height || line.baseline > 0.93 * height;
  };
  const bodyLines = (page: number, fromY: number, toY: number) => model.linesByPage[page].filter((l) => !l.synthetic && l.baseline > fromY && l.baseline < toY && !isFurniture(l)).length;
  const xRange = (c: Cluster): [number, number] => [Math.min(...c.cands.map((k) => k.labelX0)), Math.max(...c.cands.map((k) => k.blank.x1))];
  for (const loose of clusters) {
    tick();
    if (loose.page === 0 || !loose.cands.length || isSigningCluster(loose) || loose.party) continue;
    if (!loose.cands.every((c) => DETAIL_KINDS.includes(c.kind) && !c.party && c.blank.page === loose.page)) continue;
    const top = Math.min(...loose.cands.map((c) => c.blank.y));
    const [lx0, lx1] = xRange(loose);
    const overlaps = (c: Cluster) => {
      const [x0, x1] = xRange(c);
      return Math.min(x1, lx1) - Math.max(x0, lx0) > 0;
    };
    // Nothing but a running header may come before it on its page.
    if (clusters.some((c) => c !== loose && c.page === loose.page && c.cands.some((k) => k.blank.page === loose.page && k.blank.y < top) && overlaps(c))) continue;
    if (bodyLines(loose.page, 0, top - 1.2 * loose.cands[0].blank.size) > 1) continue;
    const before = clusters
      .filter((c) => c.page === loose.page - 1 && isSigningCluster(c) && overlaps(c) && c.cands.every((k) => k.blank.page === c.page))
      .sort((a, b) => Math.max(...b.cands.map((k) => k.blank.y)) - Math.max(...a.cands.map((k) => k.blank.y)))[0];
    if (!before) continue;
    const bottom = Math.max(...before.cands.map((k) => k.blank.y));
    // The block must run to the foot of its page, and must not already have what the continuation holds.
    if (bodyLines(before.page, bottom + 4, Number.POSITIVE_INFINITY) > 1) continue;
    if (clusters.some((c) => c !== before && c.page === before.page && c.cands.some((k) => k.blank.y > bottom + 4) && overlaps(c))) continue;
    if (loose.cands.some((l) => before.cands.some((k) => k.kind === l.kind))) continue;
    before.cands.push(...loose.cands);
    loose.cands = [];
  }
  // "Signature ______   Date ______" on one row is one block even when a column split
  // elsewhere in the band put the date on the other side.
  for (const loose of clusters.filter((c) => !isSigningCluster(c) && c.cands.length > 0)) {
    const host = clusters.find(
      (c) =>
        c !== loose &&
        c.page === loose.page &&
        isSigningCluster(c) &&
        loose.cands.every((l) => !c.cands.some((k) => k.kind === l.kind) && c.cands.some((k) => k.kind === "signature" && Math.abs(k.blank.y - l.blank.y) < 5 && k.blank.x1 <= l.labelX0 + 2)) &&
        (!loose.party || !c.party || loose.party.party === c.party.party),
    );
    if (host) {
      host.cands.push(...loose.cands);
      loose.cands = [];
    }
  }
  // Reading order, so "first block" means the first one a person would see.
  const topOf = (c: Cluster) => Math.min(...c.cands.filter((k) => k.blank.page === c.page).map((k) => k.blank.y));
  const live = clusters.filter((c) => c.cands.length > 0).sort((a, b) => a.page - b.page || (Math.abs(topOf(a) - topOf(b)) < 6 ? a.column - b.column : topOf(a) - topOf(b)));
  clusters.length = 0;
  clusters.push(...live);
  const signing = clusters.filter(isSigningCluster);
  for (const cluster of signing) cluster.role = cluster.party?.party;
  const known = (role: "client" | "company") => signing.some((c) => c.role === role);
  if (signing.length > 1 && !known("client") && signing.every((c) => c.role === "company")) {
    // Every block reads as "the company" (for example Consultant and Company). One of them
    // is the sender; keep the one with the strongest evidence and treat the rest as the client.
    const keep = signing.slice().sort((a, b) => b.party!.strength - a.party!.strength)[0];
    for (const cluster of signing) {
      if (cluster !== keep) {
        cluster.role = "client";
        cluster.guessed = true;
      }
    }
  }
  const unknown = signing.filter((c) => !c.role);
  if (unknown.length === 1) {
    unknown[0].role = !known("client") ? "client" : !known("company") ? "company" : "client";
    // With the other party named, the remaining block is the remaining party: not a guess.
    unknown[0].guessed = signing.length !== 2 || known("client") === known("company");
  } else if (unknown.length > 1) {
    let companyPick: Cluster | null = null;
    if (!known("company")) {
      const withTitle = unknown.filter((c) => c.cands.some((k) => k.kind === "title"));
      companyPick = withTitle.length === 1 ? withTitle[0] : unknown[1];
    }
    for (const cluster of unknown) {
      cluster.role = cluster === companyPick ? "company" : "client";
      cluster.guessed = true;
    }
  }

  const roleCounts = { client: 0, company: 0 };
  for (const cluster of clusters) {
    const isSigning = signing.includes(cluster);
    if (isSigning) {
      const role = cluster.role!;
      const ordinal = ++roleCounts[role];
      stats.signatureBlocks++;
      if (cluster.guessed) stats.guessedRoles = true;
      for (const cand of cluster.cands) {
        let type: FieldType;
        switch (cand.kind) {
          case "signature":
            type = "signature";
            break;
          case "date":
            type = "date_signed";
            break;
          case "full_name":
          case "title":
          case "company":
          case "email":
            type = cand.kind;
            break;
          case "party":
            // "Company: ____" inside a signer's block is that signer's organization.
            type = cand.party?.party === "company" ? "company" : "full_name";
            break;
          default:
            type = "text";
        }
        if (type === "signature") stats[role === "client" ? "clientSignatures" : "companySignatures"]++;
        const base = cand.labelFrom === "under" ? 0.85 : cand.labelFrom === "above" ? 0.75 : cand.labelFrom === "none" ? 0.55 : 0.9;
        const confidence = base - (cand.implicit ? 0.25 : 0) - (cluster.guessed ? 0.15 : 0) - (cand.blank.source === "dots" ? 0.05 : 0);
        const side = role === "client" ? "Client" : "Company";
        const fallback = cand.kind === "phone" ? `${side} phone` : cand.kind === "address" ? `${side} address` : `${side} details`;
        const label = labelFor(role, type, fallback) + (ordinal > 1 ? ` (${ordinal})` : "");
        const required = type === "signature" || type === "full_name" || type === "date_signed";
        emit(cand.blank, type, role, required, type === "text" ? fallback + (ordinal > 1 ? ` (${ordinal})` : "") : label, confidence);
      }
      continue;
    }
    // A group with no signature is a details panel ("Client name: ____  Date: ____"):
    // fill it from the file instead of asking the client to type what the sender already knows.
    for (const cand of cluster.cands) {
      if (cand.implicit) continue;
      const side = (cand.party ?? cluster.party)?.party ?? "client";
      const conf = cand.labelFrom === "left" ? 0.75 : 0.65;
      const before = fields.length;
      // "Client Name: ____   Company: ____": next to the client's own details, a bare "Company" asks
      // who the client works for. The sender's name is never a blank in its own agreement's client panel.
      const clientPanel = cluster.cands.some((c) => c !== cand && c.party?.party === "client");
      const bareCompany = side === "company" && (cand.kind === "party" || cand.kind === "company") && (cand.party?.strength ?? 1) === 1 && BARE_ORGANIZATION.test(normalize(cand.labelText ?? ""));
      if (clientPanel && bareCompany) emit(cand.blank, "company", "prefill", false, "Client company", conf - 0.1, "client_company");
      else if (side === "company") {
        if (cand.kind === "full_name" || cand.kind === "company" || cand.kind === "party") emit(cand.blank, "company", "prefill", false, "Company name", conf - 0.1, "company_name");
        else if (cand.kind === "date") emit(cand.blank, "date", "prefill", false, "Agreement date", conf, "today");
        else emitBody(cand.blank);
      } else if (cand.kind === "full_name" || cand.kind === "party") emit(cand.blank, "full_name", "prefill", false, "Client name", conf, "client_name");
      else if (cand.kind === "company") emit(cand.blank, "company", "prefill", false, "Client company", conf, "client_company");
      else if (cand.kind === "title") emit(cand.blank, "title", "prefill", false, "Client title", conf, "client_title");
      else if (cand.kind === "email") emit(cand.blank, "email", "prefill", false, "Client email", conf, "client_email");
      else if (cand.kind === "phone") emit(cand.blank, "text", "prefill", false, "Client phone", conf, "client_phone");
      else if (cand.kind === "date") emit(cand.blank, "date", "prefill", false, "Agreement date", conf, "today");
      else if (cand.kind === "address") emit(cand.blank, "text", "client", false, "Client address", 0.6);
      else emitBody(cand.blank);
      if (fields.length > before && fields[fields.length - 1].role === "prefill" && cand.kind !== "address") stats.prefills++;
    }
  }

  // ---- 5. Initials (usually one line at the foot of each page) --------------
  for (const cand of initials) {
    const role = cand.party?.party ?? "client";
    emit(cand.blank, "initials", role, true, `${role === "client" ? "Client" : "Company"} initials (page ${cand.blank.page + 1})`, cand.implicit ? 0.6 : 0.85);
    stats.initials++;
  }

  return { fields, origins, model, stats };
}

/** A short party or witness heading among the text between two heights, on one side of the column split. */
function headingIn(
  model: Model,
  page: number,
  fromY: number,
  toY: number,
  split: number | undefined,
  column: 0 | 1,
  consumed: Set<Piece>,
  vocab: Vocabulary,
): Heading | null {
  for (const line of model.linesByPage[page]) {
    if (line.synthetic || line.baseline <= fromY || line.baseline >= toY) continue;
    if (line.pieces.some((p) => p.kind === "blank")) continue;
    const match = headingOf(line, split, column, consumed, vocab);
    if (match) return match;
  }
  return null;
}

function headingOf(line: Line, split: number | undefined, column: 0 | 1, consumed: Set<Piece>, vocab: Vocabulary, maxX = Number.POSITIVE_INFINITY): Heading | null {
  for (const piece of line.pieces) {
    if (piece.kind !== "text" || consumed.has(piece) || piece.x0 >= maxX) continue;
    if (split !== undefined && ((piece.x0 + Math.min(piece.x1, piece.x0 + 120)) / 2 < split ? 0 : 1) !== column) continue;
    if (wordCount(piece.text) > 9) continue;
    if (isWitnessHeading(piece.text)) return "witness";
    const match = partyOf(piece.text, vocab.companyName, vocab.terms);
    // In running text "the company" proves nothing; a heading is short or is the sender's own name.
    if (match && (match.strength >= 3 || isPartyHeading(piece.text, vocab.companyName, vocab.terms))) return match;
  }
  return null;
}

/** The nearest heading above a block: "CLIENT:", "For the Company", "ASTRA AI, INC.", or "WITNESS". */
function headingAbove(model: Model, cluster: Cluster, all: Cluster[], consumed: Set<Piece>, vocab: Vocabulary, furniture: Set<Line>): Heading | null {
  const first = cluster.cands[0];
  const sameRow = headingOf(first.blank.line, cluster.split, cluster.column, consumed, vocab, first.labelX0);
  if (sameRow) return sameRow;
  const top = Math.min(...cluster.cands.map((c) => c.blank.y)) - 0.8 * first.blank.size;
  const foreign = new Set<Blank>();
  for (const other of all) {
    if (other !== cluster && other.page === cluster.page && other.column === cluster.column) for (const c of other.cands) foreign.add(c.blank);
  }
  const isForeign = (p: Piece) => Boolean(p.blank) && [...foreign].some((b) => b === p.blank || b.id.startsWith(`${p.blank!.id}.`));
  const own = new Set(cluster.cands.map((c) => c.blank.line));
  const lines = model.linesByPage[cluster.page];
  let seen = 0;
  let reachedTop = true;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.baseline >= top) continue;
    if (seen >= 7 || line.baseline < top - 150) {
      reachedTop = false;
      break;
    }
    // Another block's lines end the search: its heading is not ours.
    if (line.pieces.some(isForeign)) return null;
    // The block's own labels (a table cell's label sits above its writing line) and running headers are not headings.
    if (line.synthetic || own.has(line) || furniture.has(line)) continue;
    seen++;
    const match = headingOf(line, cluster.split, cluster.column, consumed, vocab);
    if (match) return match;
    if (isSigningMarker(renderLine(line))) return null;
  }
  // The block opens its page: its heading may be the last thing printed on the page before
  // ("CLIENT" at the foot of page 3, "By: ____" at the head of page 4).
  if (!reachedTop || cluster.page === 0 || seen > 2) return null;
  const previous = model.linesByPage[cluster.page - 1];
  const height = model.pages[cluster.page - 1].height;
  let looked = 0;
  for (let i = previous.length - 1; i >= 0 && looked < 3; i--) {
    const line = previous[i];
    // Page numbers and running footers sit below the body and say nothing about the parties.
    if (line.synthetic || furniture.has(line) || line.baseline > 0.93 * height) continue;
    if (line.pieces.some((p) => p.kind === "blank")) return null;
    looked++;
    const match = headingOf(line, cluster.split, cluster.column, consumed, vocab);
    if (match) return match;
    if (isSigningMarker(renderLine(line))) return null;
  }
  return null;
}

function area(f: Field): number {
  return f.w * f.h;
}

function overlapArea(a: Field, b: Field): number {
  if (a.page !== b.page) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** What to keep when there are more fields than a template may hold: places to sign first. */
function fieldPriority(f: Field): number {
  return f.type === "signature" ? 0 : f.role !== "prefill" && f.required ? 1 : f.role === "prefill" ? 2 : 3;
}

const SOURCE_RANK: Record<Field["source"], number> = { manual: 4, form: 3, appended: 2, detected: 1 };

/**
 * Final clean-up shared by every strategy: clamp to the page, drop duplicates,
 * separate fields that touch, and cap the total.
 */
export function finalizeFields(input: Field[], pageCount: number, limit: number): Field[] {
  const valid: Field[] = [];
  for (const raw of input) {
    if (!Number.isInteger(raw.page) || raw.page < 0 || raw.page >= pageCount) continue;
    const rect = clampRect(raw);
    if (rect.w < 0.004 || rect.h < 0.003) continue;
    valid.push({ ...raw, ...rect });
  }
  // Comparing every field with every other is quadratic; far beyond the limit, keep the most important first.
  const ceiling = Math.max(limit * 8, 2000);
  if (valid.length > ceiling) {
    const order = valid.map((field, index) => ({ field, index })).sort((a, b) => fieldPriority(a.field) - fieldPriority(b.field) || (b.field.confidence ?? 1) - (a.field.confidence ?? 1) || a.index - b.index);
    const keepIndex = new Set(order.slice(0, ceiling).map((o) => o.index));
    valid.splice(0, valid.length, ...valid.filter((_, index) => keepIndex.has(index)));
  }
  // Strongest first, so the weaker of two overlapping fields is the one that gives way.
  const ranked = valid
    .map((field, index) => ({ field, index }))
    .sort((a, b) => SOURCE_RANK[b.field.source] - SOURCE_RANK[a.field.source] || (b.field.confidence ?? 1) - (a.field.confidence ?? 1) || a.index - b.index);
  const kept: { field: Field; index: number }[] = [];
  for (const entry of ranked) {
    let field = entry.field;
    let drop = false;
    for (const other of kept) {
      const shared = overlapArea(field, other.field);
      if (shared <= 0) continue;
      if (shared >= 0.5 * Math.min(area(field), area(other.field))) {
        drop = true;
        break;
      }
      const overlapW = Math.min(field.x + field.w, other.field.x + other.field.w) - Math.max(field.x, other.field.x);
      if (overlapW < 0.3 * Math.min(field.w, other.field.w)) {
        // Neighbours on one row that touch: trim this one's side back.
        if (other.field.x > field.x) field = { ...field, w: Math.max(0, other.field.x - field.x) };
        else {
          const right = field.x + field.w;
          const start = other.field.x + other.field.w;
          field = { ...field, x: start, w: Math.max(0, right - start) };
        }
        if (field.w < 0.01) {
          drop = true;
          break;
        }
        continue;
      }
      // Stacked fields that touch: pull this one's edge back off its neighbour.
      const otherBottom = other.field.y + other.field.h;
      const bottom = field.y + field.h;
      if (other.field.y <= field.y) field = { ...field, y: Math.min(otherBottom, bottom), h: Math.max(0, bottom - otherBottom) };
      else field = { ...field, h: Math.max(0, other.field.y - field.y) };
      if (field.h < 0.006) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push({ field, index: entry.index });
  }
  let result = kept.sort((a, b) => a.index - b.index).map((k) => k.field);
  if (result.length > limit) {
    const priority = fieldPriority;
    const keepIds = new Set(
      result
        .slice()
        .sort((a, b) => priority(a) - priority(b) || (b.confidence ?? 1) - (a.confidence ?? 1))
        .slice(0, limit)
        .map((f) => f.id),
    );
    result = result.filter((f) => keepIds.has(f.id));
  }
  return result.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
