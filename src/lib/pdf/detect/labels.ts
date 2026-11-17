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
  /** 3: the sender's own name, or a term the agreement itself defines for a party. 2: looks like a legal entity. 1: a generic word. */
  strength: 1 | 2 | 3;
}

/**
 * What the agreement calls each party, read from its opening sentence
 * ('Astra AI, LLC ("Consultant") and ____ ("Company")'). Normalized words.
 * These outrank the generic vocabulary: in that agreement "Company" is the client.
 */
export interface DefinedTerms {
  sender: string[];
  client: string[];
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
function residue(normalized: string, companyName?: string, terms?: DefinedTerms): string {
  let rest = ` ${normalized} `;
  for (const term of [...(terms?.sender ?? []), ...(terms?.client ?? [])]) rest = rest.split(` ${term} `).join(" ");
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
export function isPartyHeading(text: string, companyName?: string, terms?: DefinedTerms): boolean {
  return residue(normalize(text), companyName, terms) === "";
}

function termIndex(padded: string, list: string[] | undefined): number {
  let best = -1;
  for (const term of list ?? []) {
    let at = padded.indexOf(` ${term} `);
    // "Companies" and "Clients" still name the party.
    if (at < 0) at = padded.indexOf(` ${term}s `);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

/** Which party a heading or label refers to, if it says. */
export function partyOf(text: string, companyName?: string, terms?: DefinedTerms): PartyMatch | null {
  const n = normalize(text);
  if (!n) return null;
  if (mentionsCompanyName(n, companyName)) return { party: "company", strength: 3 };
  if (terms) {
    const padded = ` ${n} `;
    const asSender = termIndex(padded, terms.sender);
    const asClient = termIndex(padded, terms.client);
    if (asClient >= 0 || asSender >= 0) {
      // As a heading the defined term is decisive; inside a longer phrase it is only a mention.
      const strength = residue(n, companyName, terms) === "" ? 3 : 1;
      return { party: asClient >= 0 && (asSender < 0 || asClient < asSender) ? "client" : "company", strength };
    }
  }
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
export function classifyLabel(text: string, companyName?: string, terms?: DefinedTerms): LabelMatch | null {
  const n = normalize(text);
  if (!n || n.length > 80) return null;
  const party = partyOf(text, companyName, terms);
  const kind = kindOf(n);
  // "Signed by the parties:" and "Signature requirements" mention signing without being a line to sign on.
  if (kind === "signature" && residue(n, companyName, terms) !== "") return null;
  if (kind) return { kind, party };
  if (!party || n.split(" ").length > 6) return null;
  if (PARTY_ONLY.test(n) || residue(n, companyName, terms) === "") return { kind: "party", party };
  // A bare entity name ("Blue Heron Consulting LLC") names a party; a clause that mentions one does not.
  const clause = /["\u201c\u201d()]/.test(text) || /\b(between|and|with|by|to|is|are|this|that|agrees?|shall|will|from)\b/.test(n);
  if (party.strength >= 2 && !clause) return { kind: "party", party };
  return null;
}

/**
 * True for a heading that opens a witness or notary block ("WITNESS", "Notary Public",
 * "Signed in the presence of:"). The lines under it belong to neither signer.
 * "IN WITNESS WHEREOF" opens the parties' own signatures and is not one of these.
 */
export function isWitnessHeading(text: string): boolean {
  const n = normalize(text);
  if (!n || n.split(" ").length > 7 || /\b(whereof|thereof)\b/.test(n)) return false;
  if (!WITNESS_WORDS.test(n)) return false;
  const rest = n
    .replace(new RegExp(WITNESS_WORDS.source, "g"), " ")
    .replace(FILLER, " ")
    .replace(/\b(public|in|presence|before|me|was|this|document|agreement|seal|acknowledg\w*|sworn|subscribed|certificate|jurat)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest === "";
}

const WITNESS_WORDS = /\b(witness|witnesses|witnessed|notary|notarized|notarised|attest|attested|attestation|in the presence of)\b/;

function kindOf(n: string): LabelKind | null {
  if (WITNESS_WORDS.test(n) && !/\b(whereof|thereof)\b/.test(n)) return "witness";
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
  /** The words before the blank decide it; a party definition after it must not override. */
  settled?: boolean;
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
  // "as of ____________, 20____": the year is its own blank after a printed "20", so the
  // first blank takes the month and day and the second the last two digits.
  if (/_\s*,\s*20\s*$/.test(l)) return { type: "text", role: "prefill", mergeKey: "custom:today_year_short", label: "Agreement date: year", confidence: 0.7 };
  if (dateLead && !otherDate && /^\s*,\s*20\s*_/.test(rl)) return { type: "text", role: "prefill", mergeKey: "custom:today_month_day", label: "Agreement date: month and day", confidence: 0.75 };
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

  // "with its principal place of business at ____ ("Client")": the blank is an address, even
  // though the definition after it names the party. Only the client can supply it.
  if (/\b(place of business|registered office|offices?|address|residing|resides|located|domiciled)\s*(is|are)?\s*(at|in|of|:)?\s*$/.test(l)) {
    return { type: "text", role: "client", label: clientLead || CLIENT_AFTER.test(r.slice(0, 70)) ? "Client address" : "Address", confidence: 0.6, settled: true };
  }

  // "... and ________, with its principal place of business at ____ ("Client")": the name
  // comes first and its definition follows the address clause.
  const afterAddress = /^[\s,]*(?:with|having|whose|of|located|residing|an?\s+\w+(?:\s+\w+){0,4}\s+(?:with|having|whose|located))\b[^.;_]{0,80}____\s*(.{0,60})/i.exec(right.replace(/\s+/g, " ").slice(0, 220));
  if (afterAddress) {
    if (CLIENT_AFTER.test(afterAddress[1])) return { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.75 };
    if (COMPANY_AFTER.test(afterAddress[1])) return { type: "company", role: "prefill", mergeKey: "company_name", label: "Company name", confidence: 0.65 };
  }

  // "... and ________ (the "Client")": the definition right after the blank names who goes in it.
  const firstClause = r.split(/[.;]|____/)[0].slice(0, 70);
  if (CLIENT_AFTER.test(firstClause)) return { type: "full_name", role: "prefill", mergeKey: "client_name", label: "Client name", confidence: 0.8 };
  if (COMPANY_AFTER.test(firstClause)) return { type: "company", role: "prefill", mergeKey: "company_name", label: "Company name", confidence: 0.7 };

  // Only words that were written as a label ("Policy number: ____") name the field. The
  // tail of an ordinary sentence makes a label nobody can read ("California Consultant and").
  return { type: "text", role: "client", label: /[:：]\s*$/.test(left) ? tailLabel(left, "") : "", confidence: 0.4 };
}

/** A short human label from the words just before a blank. */
export function tailLabel(left: string, fallback: string): string {
  const clause = left.replace(/_{2,}|\[blank\]/g, " ").split(/[.;!?]/).pop() ?? "";
  const words = clause.replace(/[^\p{L}\p{N}$%#'’ /-]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(-4);
  const label = words.join(" ");
  if (label.length < 2) return fallback;
  return (label[0].toUpperCase() + label.slice(1)).slice(0, 60);
}

const DEFINITION = /\(([^()"“”]{0,60})["“]\s*([^"“”()]{2,32}?)\s*["”]([^()]{0,40})\)/g;
/** Defined terms that are not a party to the agreement. */
const NOT_A_PARTY =
  /^(the )?(agreement|contract|parties|party|effective date|commencement date|start date|term|initial term|services?|work|project|fees?|deliverables?|sow|statement of work|confidential information|premises|property|products?|software|site|event|engagement|purpose|territory|order|proposal|program|policy|terms|msa|nda|schedule|exhibit)$/;
const CLIENT_EVIDENCE = /_{3,}|\b(named|identified|listed|specified|signing|whose name|undersigned|set forth)\b[^.]{0,30}$/;

/**
 * Reads what the agreement calls each party from where it defines them, e.g.
 * 'between Astra AI, LLC, a Delaware company ("Consultant") and ____ ("Company")'.
 * The term that follows the sender's own name is the sender's; the term that
 * follows a blank, or the other term of the same sentence, is then the client's.
 * Returns undefined unless the sender's own name is found next to a term.
 * `text` is running text with blanks written as "____".
 */
export function findDefinedTerms(text: string, companyName?: string): DefinedTerms | undefined {
  const body = text.slice(0, 40_000);
  const found: { term: string; before: string; at: number; end: number }[] = [];
  let lastEnd = 0;
  DEFINITION.lastIndex = 0;
  for (let m = DEFINITION.exec(body); m && found.length < 40; m = DEFINITION.exec(body)) {
    const term = normalize(m[2]).replace(/^the /, "");
    const windowStart = Math.max(lastEnd, m.index - 220);
    lastEnd = m.index + m[0].length;
    // "(each a "Party")" and "(collectively, the "Parties")" define no one in particular.
    if (!term || term.split(" ").length > 3 || NOT_A_PARTY.test(term) || /\b(each|collectively|together|individually)\b/i.test(m[1])) continue;
    found.push({ term, before: body.slice(windowStart, m.index), at: m.index, end: lastEnd });
  }
  if (!found.length) return undefined;
  const sender = new Set<string>();
  const client = new Set<string>();
  const isSender = found.map((f) => mentionsCompanyName(normalize(f.before), companyName));
  const isClient = found.map((f, i) => !isSender[i] && CLIENT_EVIDENCE.test(f.before.slice(-90)));
  found.forEach((f, i) => {
    if (isSender[i]) sender.add(f.term);
    else if (isClient[i]) client.add(f.term);
  });
  // Two parties are defined side by side: knowing one tells us the other.
  const neighbour = (i: number, taken: boolean[]): number => {
    for (const j of [i + 1, i - 1]) {
      const other = found[j];
      if (!other || taken[j] || isSender[j] || isClient[j] || other.term === found[i].term) continue;
      const gap = j > i ? other.at - found[i].end : found[i].at - other.end;
      if (gap >= 0 && gap <= 260) return j;
    }
    return -1;
  };
  // Everything hangs on recognizing the sender by name. Without that, a blank before a term
  // could be either party's ('provided by ____ (the "Provider")'), and the generic words decide.
  if (!sender.size) return undefined;
  if (!client.size) {
    const taken = found.map(() => false);
    found.forEach((_, i) => {
      if (!isSender[i] || client.size) return;
      const j = neighbour(i, taken);
      if (j >= 0) {
        client.add(found[j].term);
        taken[j] = true;
      }
    });
  }
  // A term claimed by both sides tells us nothing.
  for (const term of [...sender]) {
    if (client.has(term)) {
      sender.delete(term);
      client.delete(term);
    }
  }
  if (!sender.size) return undefined;
  return { sender: [...sender], client: [...client] };
}
