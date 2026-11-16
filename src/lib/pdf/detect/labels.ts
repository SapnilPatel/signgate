/**
 * Vocabulary: what the words next to a blank say about what goes in it and
 * which party fills it in. Kept free of geometry so it can be tested and
 * extended on its own.
 */
import type { MergeKey } from "@/lib/types";

export type Party = "client" | "company";

export type LabelKind =
  | "signature"
  | "initials"
  | "date"
  | "full_name"
  | "title"
  | "company"
  | "email"
  | "phone"
  | "address"
  /** Only a party is named ("Client: ____"); what it holds depends on where it sits. */
  | "party"
  /** Witness and notary lines belong to neither signer. */
  | "witness";

export interface PartyMatch {
  party: Party;
  /** 3: the sender's own name. 2: looks like a legal entity. 1: a generic word. */
  strength: 1 | 2 | 3;
}

const CLIENT_WORDS =
  /\b(client|customer|patient|tenant|lessee|buyer|purchaser|member|participant|applicant|guest|student|homeowner|borrower|licensee|subscriber|parent|guardian|recipient|undersigned|insured|claimant|policyholder|resident|renter|attendee|donor|investor)s?\b/;
const COMPANY_WORDS =
  /\b(company|provider|consultant|contractor|agency|firm|vendor|supplier|seller|landlord|lessor|lender|licensor|employer|practice|clinic|attorney|counsel|advis[eo]r|broker|agent|studio|coach|therapist|freelancer|designer|developer|photographer|planner|corporation|organizer|trainer|instructor|practitioner)s?\b/;
const ENTITY_SUFFIX = /\b(inc|incorporated|llc|l l c|ltd|limited|corp|llp|plc|gmbh|pty|pllc|lp|s a|b v|ag)\b/;
const ENTITY_FILLER = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "llp", "plc", "gmbh", "pty", "the", "and", "of"]);

/** Lowercase words only: punctuation, quotes and possessives removed. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function wordCount(text: string): number {
  const n = normalize(text);
  return n ? n.split(" ").length : 0;
}

function mentionsCompanyName(normalized: string, companyName?: string): boolean {
  if (!companyName) return false;
  const name = normalize(companyName);
  if (name.length < 2) return false;
  const padded = ` ${normalized} `;
  if (padded.includes(` ${name} `)) return true;
  // "Astra AI, Inc." on the page should match a company registered as "Astra AI" and the reverse.
  const core = name.split(" ").filter((w) => !ENTITY_FILLER.has(w));
  if (!core.length) return false;
  const coreName = core.join(" ");
  return coreName.length >= 3 && padded.includes(` ${coreName} `);
}

const FILLER =
  /\b(signature|signatures|signed|sign|signatory|signer|here|by|x|of|the|authori[sz]ed|representative|rep|officer|and|or|date|dated|name|title|print|printed|for|on|behalf|please|above|below|duly|legal|electronic|digital|accepted|agreed|approved|executed|acknowledged|acknowledge?ment|acceptance|approval|if|applicable|required|under|over|age|minor|party|first|second|to|as|s|a|b|\d+)\b/g;

/** What is left of a label once party words and the usual signature-block words are removed. */
function residue(normalized: string, companyName?: string): string {
  let rest = ` ${normalized} `;
  if (companyName) {
    const name = normalize(companyName);
    if (name) rest = rest.split(` ${name} `).join(" ");
    for (const word of name.split(" ")) if (word.length > 1) rest = rest.split(` ${word} `).join(" ");
  }
  return rest
    .replace(new RegExp(CLIENT_WORDS.source, "g"), " ")
    .replace(new RegExp(COMPANY_WORDS.source, "g"), " ")
    .replace(ENTITY_SUFFIX, " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True for text that reads as the heading of a party's block ("CLIENT:", "Accepted by
 * the Company", "For Astra AI") rather than a phrase that merely mentions a party
 * ("Client comments", "Company policies").
 */
export function isPartyHeading(text: string, companyName?: string): boolean {
  return residue(normalize(text), companyName) === "";
}

/** Which party a heading or label refers to, if it says. */
export function partyOf(text: string, companyName?: string): PartyMatch | null {
  const n = normalize(text);
  if (!n) return null;
  if (mentionsCompanyName(n, companyName)) return { party: "company", strength: 3 };
  const client = n.search(CLIENT_WORDS);
  const company = n.search(COMPANY_WORDS);
  if (client >= 0 && (company < 0 || client < company)) return { party: "client", strength: 1 };
  if (company >= 0) return { party: "company", strength: 1 };
  if (ENTITY_SUFFIX.test(n)) return { party: "company", strength: 2 };
  return null;
}

export interface LabelMatch {
  kind: LabelKind;
  party: PartyMatch | null;
}

const PARTY_ONLY = new RegExp(`^(the )?(${CLIENT_WORDS.source}|${COMPANY_WORDS.source})( name)?$`);

/**
 * Reads a short label such as "Client Signature:", "By", "Print Name" or
 * "(Date)". Returns null when the words are not a recognizable label.
 */
export function classifyLabel(text: string, companyName?: string): LabelMatch | null {
  const n = normalize(text);
  if (!n || n.length > 80) return null;
  const party = partyOf(text, companyName);
  const kind = kindOf(n);
  // "Signed by the parties:" and "Signature requirements" mention signing without being a line to sign on.
  if (kind === "signature" && residue(n, companyName) !== "") return null;
  if (kind) return { kind, party };
  if (!party || n.split(" ").length > 6) return null;
  if (PARTY_ONLY.test(n) || residue(n, companyName) === "") return { kind: "party", party };
  // A bare entity name ("Blue Heron Consulting LLC") names a party; a clause that mentions one does not.
  const clause = /["\u201c\u201d()]/.test(text) || /\b(between|and|with|by|to|is|are|this|that|agrees?|shall|will|from)\b/.test(n);
  if (party.strength >= 2 && !clause) return { kind: "party", party };
  return null;
  return null;
}

function kindOf(n: string): LabelKind | null {
  if (/\b(witness|witnessed|notary|notarized)\b/.test(n)) return "witness";
  if (/\binitial(s|ed)?\b|\binit\b/.test(n)) return "initials";
  if (/\be ?mail\b/.test(n)) return "email";
  if (/\b(phone|telephone|tel|mobile|cell|fax)\b/.test(n)) return "phone";
  if (/\b(address|city|state|zip|postal|postcode)\b/.test(n)) return "address";
  if (/\b(date|dated)\b/.test(n)) return /\b(birth|dob|expir\w*|due|start|end|terminat\w*|deliver\w*|complet\w*|event|service|session|move)\b/.test(n) ? null : "date";
  const signature = /\b(signature|signed|signatory|autograph|sign here|sign)\b/.test(n) || /^(by|x)$/.test(n) || /^(signed|accepted|agreed|approved|executed|authori[sz]ed|acknowledged)( (and|to and) (accepted|agreed|acknowledged))? by$/.test(n);
  // "Signatures" as a heading and "signature page" name a section, not a line to sign on.
  const sectionWord = /\bsignatures\b|\bsignature (page|block|section)\b/.test(n);
  const name = /\b(name|print|printed|typed)\b/.test(n);
  if (name) {
    if (signature && /\b(and|or)\b/.test(n) && !/\bprint(ed)?\b/.test(n)) return "signature";
    if (/\b(company|organi[sz]ation|business|entity|firm|employer)\b/.test(n) && !/\b(signatory|signer|representative|print|printed)\b/.test(n)) return "company";
    return "full_name";
  }
  if (signature && !sectionWord) return "signature";
  if (/\b(title|its|position|designation|capacity)\b/.test(n)) return "title";
  if (/\b(organi[sz]ation|business|entity|employer)\b/.test(n)) return "company";
  return null;
}

/** Lines that open the part of a document where the parties sign. */
export function isSigningMarker(text: string): boolean {
  const n = normalize(text);
  return /\bin witness (whereof|thereof)\b|\bsignature page\b|\b(agreed|accepted|acknowledged) (and|to and) (accepted|agreed|acknowledged)\b|\b(signing|signed|sign|signatures?) below\b|^signatures?$|\bintending to be legally bound\b|\bduly authorized\b/.test(
    n,
  );
}

export interface BodyMatch {
  type: "date" | "full_name" | "company" | "email" | "title" | "text";
  role: "prefill" | "client";
  mergeKey?: MergeKey;
  label: string;
  confidence: number;
}

const CLIENT_AFTER = /^[\s,]*\(?\s*(?:hereinafter|hereafter|herein|referred to as|called|known as|the|as|a|an|\s|,|"|“|”|\()*["“(]*\s*(?:the\s+)?["“]?(client|customer|patient|tenant|member|participant|buyer|purchaser|you|subscriber|homeowner|borrower|licensee|recipient)\b/i;
const COMPANY_AFTER = /^[\s,]*\(?\s*(?:hereinafter|hereafter|herein|referred to as|called|known as|the|as|a|an|\s|,|"|“|”|\()*["“(]*\s*(?:the\s+)?["“]?(company|provider|service provider|consultant|contractor|agency|firm|vendor|supplier|seller|landlord|we|us|licensor|lender)\b/i;

/**
 * Classifies a blank inside running text from the words around it.
 * `left` and `right` are the text before and after the blank with other blanks
 * written as "____".
 */
export function classifyBodyBlank(left: string, right: string): BodyMatch {
  const l = left.replace(/\s+/g, " ").trimEnd().slice(-90).toLowerCase();
  const r = right.replace(/\s+/g, " ").trimStart().slice(0, 90);
  const rl = r.toLowerCase();

  // "this ____ day of ________, 20__": three blanks that together spell today's date.
  if (/^(st|nd|rd|th)?\s*day of\b/.test(rl)) return { type: "text", role: "prefill", mergeKey: "custom:today_day", label: "Agreement date: day", confidence: 0.75 };
  if (/day of\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "custom:today_month", label: "Agreement date: month", confidence: 0.75 };
  if (/day of\s*_+\s*,?\s*20\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "custom:today_year_short", label: "Agreement date: year", confidence: 0.7 };
  if (/day of\s*_+\s*,?\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "custom:today_year", label: "Agreement date: year", confidence: 0.7 };

  const otherDate = /\b(birth|dob|expir\w*|due|start|end|terminat\w*|deliver\w*|complet\w*|event|service|session|move)\b[^.]{0,20}$/.test(l);
  const dateLead =
    /\b(dated|date|made|entered into|effective|executed|commenc\w*|as of|signed)\b\s*(and entered into\s*)?(effective\s*)?(as of|on|this|of)?\s*[:,]?\s*(the|this)?\s*$/.test(l) ||
    /^[\s,]*\(?\s*(the\s+)?["“]?effective date/.test(rl);
  if (dateLead && !otherDate) return { type: "date", role: "prefill", mergeKey: "today", label: "Agreement date", confidence: 0.8 };
  if (/\bdate\b\s*[:]?\s*$/.test(l)) return { type: "date", role: "client", label: tailLabel(left, "Date"), confidence: 0.5 };

  if (/\b(file|case|matter|job|project|reference|ref|claim|policy|order|account|engagement)\s*(no|number|num|id)?\.?\s*#?\s*:?\s*$/.test(l) && /(no|number|num|id|ref|reference|#)\.?\s*#?\s*:?\s*$/.test(l))
    return { type: "text", role: "prefill", mergeKey: "file_reference", label: "File reference", confidence: 0.75 };
  if (/(^|\s)(re|matter|project|job|case|subject|description|engagement)\s*:\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "file_description", label: "File description", confidence: 0.6 };

  const clientLead = /\b(client|customer|patient|tenant|member|participant)(['’]s)?\b/.test(l.slice(-40));
  if (/\be-?mail( address)?\s*:?\s*$/.test(l)) return { type: "email", role: "prefill", mergeKey: "client_email", label: "Client email", confidence: clientLead ? 0.75 : 0.55 };
  if (/\b(phone|telephone|tel|mobile|cell)( number| no\.?)?\s*:?\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "client_phone", label: "Client phone", confidence: clientLead ? 0.75 : 0.55 };
  if (/\b(client|customer)(['’]s)?\s+(company|organi[sz]ation|business)( name)?\s*:?\s*$/.test(l)) return { type: "company", role: "prefill", mergeKey: "client_company", label: "Client company", confidence: 0.75 };
  if (/\b(client|customer)(['’]s)?\s+(title|position)\s*:?\s*$/.test(l)) return { type: "title", role: "prefill", mergeKey: "client_title", label: "Client title", confidence: 0.7 };
  if (/\b(client|customer|patient|tenant|member|participant)(['’]s)?\s*(full |legal )?(name)?\s*:?\s*$/.test(l)) return { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.8 };

  // "I, ____________, agree to ..." is the client naming themselves.
  if (/(^|[\s.:])i,?\s*$/.test(l) && /^\s*,?\s*(the undersigned|hereby|agree|acknowledge|understand|consent|authori[sz]e|certify|have|am|,)/.test(rl))
    return { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.7 };

  // "... and ________ (the "Client")": the definition right after the blank names who goes in it.
  const firstClause = r.split(/[.;]|____/)[0].slice(0, 70);
  if (CLIENT_AFTER.test(firstClause)) return { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.8 };
  if (COMPANY_AFTER.test(firstClause)) return { type: "company", role: "prefill", mergeKey: "company_name", label: "Company name", confidence: 0.7 };

  return { type: "text", role: "client", label: tailLabel(left, ""), confidence: 0.4 };
}

/** A short human label from the words just before a blank. */
export function tailLabel(left: string, fallback: string): string {
  const clause = left.replace(/_{2,}|\[blank\]/g, " ").split(/[.;!?]/).pop() ?? "";
  const words = clause.replace(/[^\p{L}\p{N}$%#'’ /-]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(-4);
  const label = words.join(" ");
  if (label.length < 2) return fallback;
  return (label[0].toUpperCase() + label.slice(1)).slice(0, 60);
}
