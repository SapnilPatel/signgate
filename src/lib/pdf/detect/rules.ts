/**
 * Rule-based detection: reads the geometry of the page the way a person does.
 * A blank is labelled by the words to its left, under it or above it; labelled
 * blanks that sit together form a signature block; a block belongs to whichever
 * party its heading or labels name.
 */
import type { Field, FieldRole, FieldType, MergeKey } from "@/lib/types";
import { newId } from "@/lib/ids";
import { clampRect } from "../geometry";
import { rectFor, renderLine, type Blank, type Line, type Model, type Piece } from "./layout";
import { classifyBodyBlank, classifyLabel, isPartyHeading, isSigningMarker, partyOf, wordCount, type LabelKind, type PartyMatch } from "./labels";

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
function underPieces(model: Model, blank: Blank): { line: Line; pieces: Piece[] } | null {
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
  if (!hitBlank && right.trim().length < 14 && li >= 0 && li + 1 < lines.length) {
    const next = lines[li + 1];
    if (!next.synthetic && next.baseline - blank.line.baseline <= 2.4 * Math.max(next.size, blank.line.size)) right += ` ${next.pieces.map(show).join(" ")}`;
  }
  return { left, right };
}

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

export function detectByRules(model: Model, companyName?: string): RuleResult {
  const fields: Field[] = [];
  const origins = new Map<string, FieldOrigin>();
  const stats = { signatureBlocks: 0, clientSignatures: 0, companySignatures: 0, guessedRoles: false, prefills: 0, openBlanks: 0, initials: 0, witnessLines: 0 };
  const pageCount = model.pages.length;
  const consumed = new Set<Piece>();

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
    const match = classifyBodyBlank(ctx.left, ctx.right);
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

  for (const blank of model.blanks) {
    const form = blank.form;
    if (form?.type === "checkbox") {
      const ctx = contextAround(model, blank);
      const party = partyOf(`${form.label} ${ctx.left.slice(-40)} ${ctx.right.slice(0, 40)}`, companyName);
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
    let leftMatch = left && wordCount(leftText) <= 6 ? classifyLabel(leftText, companyName) : null;
    if (left && !leftMatch) {
      // "... agrees to the terms above. Signature: ____": a label at the end of a sentence.
      const tail = /((?:[\p{L}'’]+\s+){0,2}(?:signature|signed by|sign here|signed|initials?))\s*:\s*$/iu.exec(leftText);
      if (tail && wordCount(leftText) > 6) leftMatch = classifyLabel(tail[1], companyName);
    }
    // A caption underneath only counts for a blank that stands on its own: inside a
    // sentence, the text below is just the next line of the paragraph.
    const inProse = Boolean(left) && !leftMatch;
    const under = inProse || (leftMatch && leftMatch.kind !== "party") ? null : underPieces(model, blank);
    const above = left ? null : abovePiece(model, blank);
    const right = left ? null : rightPiece(blank);
    // A bare party word after a blank is a definition ('____ (the "Client")'), which the body rules read.
    const rightRead = right && wordCount(right.text) <= 5 ? classifyLabel(right.text, companyName) : null;
    const rightMatch = rightRead && rightRead.kind !== "party" ? rightRead : null;
    const aboveMatch = above && wordCount(above.text) <= 6 ? classifyLabel(above.text, companyName) : null;

    const formMatch = form ? (formKind(form.type) ? { kind: formKind(form.type)!, party: partyOf(form.label, companyName) } : classifyLabel(form.label, companyName)) : null;

    // One long line captioned underneath in several places ("Signature        Date") is several blanks.
    const underMatches = (under?.pieces ?? [])
      .map((piece) => ({ piece, match: wordCount(piece.text) <= 7 ? classifyLabel(piece.text, companyName) : null }))
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
      for (const o of ordered) if (o.piece) consumed.add(o.piece);
      if (typed.match.kind === "witness") {
        stats.witnessLines++;
        continue;
      }
      const cand: Candidate = { blank: part.blank, kind: typed.match.kind, party: partySource?.match.party ?? null, labelFrom: typed.from, labelX0, implicit: false, inZone: zone };
      if (cand.kind === "initials") initials.push(cand);
      else block.push(cand);
    }
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
  for (const line of model.lines) {
    if (line.synthetic) continue;
    line.pieces.forEach((piece, index) => {
      if (piece.kind !== "text" || consumed.has(piece) || !endsWithColon(piece.text)) return;
      const text = stripEnumerator(piece.text);
      if (wordCount(text) > 4) return;
      const match = classifyLabel(text, companyName);
      if (!match || match.kind === "witness" || match.kind === "party") return;
      const next = line.pieces[index + 1];
      const pageWidth = model.pages[line.page].width;
      const x0 = piece.x1 + 5;
      const x1 = Math.min(next ? next.x0 - 10 : Number.POSITIVE_INFINITY, x0 + 220, pageWidth - 30);
      if (x1 - x0 < 60) return;
      const blank: Blank = { id: `s-${line.id}-${index}`, page: line.page, line, x0, x1, y: line.baseline + 0.12 * line.size, size: line.size, source: "space" };
      const cand: Candidate = { blank, kind: match.kind, party: match.party, labelFrom: "left", labelX0: piece.x0, implicit: true, inZone: inZone(line.page, blank.y) };
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
          const cls = kindClass(cand.kind);
          const repeats = current !== null && ["sig", "full_name", "date", "title"].includes(cls) && current.cands.some((c) => kindClass(c.kind) === cls);
          const partyChange = current !== null && cand.party !== null && cand.kind !== "party" && current.cands.some((c) => c.party && c.kind !== "party" && c.party.party !== cand.party!.party);
          const headingBetween = prev !== null && headingIn(model, page, prev.blank.y + 2, cand.blank.y - 0.9 * cand.blank.size - 2, split, columnIndex as 0 | 1, consumed, companyName) !== null;
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
    const own = cluster.cands.filter((c) => c.party && c.kind !== "party").sort((a, b) => b.party!.strength - a.party!.strength)[0]?.party ?? null;
    const first = cluster.cands[0];
    const heading = own ? null : headingAbove(model, cluster, clusters, consumed, companyName);
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
  const topOf = (c: Cluster) => Math.min(...c.cands.map((k) => k.blank.y));
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
    unknown[0].guessed = true;
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
      if (side === "company") {
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

/** A short party heading among the text between two heights, on one side of the column split. */
function headingIn(
  model: Model,
  page: number,
  fromY: number,
  toY: number,
  split: number | undefined,
  column: 0 | 1,
  consumed: Set<Piece>,
  companyName?: string,
): PartyMatch | null {
  for (const line of model.linesByPage[page]) {
    if (line.synthetic || line.baseline <= fromY || line.baseline >= toY) continue;
    if (line.pieces.some((p) => p.kind === "blank")) continue;
    const match = headingOf(line, split, column, consumed, companyName);
    if (match) return match;
  }
  return null;
}

function headingOf(line: Line, split: number | undefined, column: 0 | 1, consumed: Set<Piece>, companyName?: string, maxX = Number.POSITIVE_INFINITY): PartyMatch | null {
  for (const piece of line.pieces) {
    if (piece.kind !== "text" || consumed.has(piece) || piece.x0 >= maxX) continue;
    if (split !== undefined && ((piece.x0 + Math.min(piece.x1, piece.x0 + 120)) / 2 < split ? 0 : 1) !== column) continue;
    if (wordCount(piece.text) > 9) continue;
    const match = partyOf(piece.text, companyName);
    // In running text "the company" proves nothing; a heading is short or is the sender's own name.
    if (match && (match.strength >= 3 || isPartyHeading(piece.text, companyName))) return match;
  }
  return null;
}

/** The nearest party heading above a block: "CLIENT:", "For the Company", "ASTRA AI, INC." */
function headingAbove(model: Model, cluster: Cluster, all: Cluster[], consumed: Set<Piece>, companyName?: string): PartyMatch | null {
  const first = cluster.cands[0];
  const sameRow = headingOf(first.blank.line, cluster.split, cluster.column, consumed, companyName, first.labelX0);
  if (sameRow) return sameRow;
  const top = Math.min(...cluster.cands.map((c) => c.blank.y)) - 0.8 * first.blank.size;
  const foreign = new Set<Blank>();
  for (const other of all) {
    if (other !== cluster && other.page === cluster.page && other.column === cluster.column) for (const c of other.cands) foreign.add(c.blank);
  }
  const lines = model.linesByPage[cluster.page];
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 7; i--) {
    const line = lines[i];
    if (line.baseline >= top) continue;
    if (line.baseline < top - 150) break;
    // Another block's lines end the search: its heading is not ours.
    if (line.pieces.some((p) => p.blank && [...foreign].some((b) => b === p.blank || b.id.startsWith(`${p.blank!.id}.`)))) break;
    if (line.synthetic) continue;
    seen++;
    const match = headingOf(line, cluster.split, cluster.column, consumed, companyName);
    if (match) return match;
    if (isSigningMarker(renderLine(line))) break;
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
    const priority = (f: Field) => (f.type === "signature" ? 0 : f.role !== "prefill" && f.required ? 1 : f.role === "prefill" ? 2 : 3);
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
