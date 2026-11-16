/**
 * Spreadsheet import: an RFC 4180 parser and the mapping from whatever column
 * headings a company already uses to the fields of a file.
 *
 * Pure (no database, no Node-only APIs beyond TextDecoder) so the same code can
 * build the import preview and run the import.
 */
import { ServiceError } from "./context";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type CsvDelimiter = "," | ";" | "\t" | "|";

export interface ParsedCsv {
  headers: string[];
  /** Data rows, each padded or cut to the header's length. Fully empty rows are dropped. */
  rows: string[][];
  /** Spreadsheet row number of each data row (the header is row 1), so messages
   *  point at the row the person sees in Excel even when blank rows were skipped. */
  rowNumbers: number[];
  delimiter: CsvDelimiter;
  warnings: string[];
}

export const CSV_LIMITS = {
  /** Larger than any 1000-row client list; protects the parser from a wrong file. */
  maxBytes: 5 * 1024 * 1024,
  maxColumns: 200,
  /** Data rows kept by the parser. The import itself takes fewer; the parser keeps
   *  more so the caller can say how many rows were over the limit. */
  maxRows: 20_000,
  maxCellLength: 5_000,
} as const;

const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t", "|"];

function decode(input: string | Uint8Array): string {
  if (typeof input === "string") return input;
  const bytes = input;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
    throw new ServiceError("invalid", "This looks like an Excel workbook, not a CSV file. In Excel choose File, Save As, CSV (Comma delimited), then upload that file.");
  }
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new ServiceError("invalid", "This looks like an old Excel (.xls) file, not a CSV file. Save it as CSV and upload that file.");
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    throw new ServiceError("invalid", "This is a PDF, not a CSV file. Upload a spreadsheet saved as CSV.");
  }
  // Excel's "Unicode Text" export is UTF-16 with a byte-order mark.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Excel on Windows saves plain "CSV" in the system code page; names with
    // accents would otherwise come through as replacement characters.
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

/** Counts each candidate delimiter in the first record, ignoring quoted text. */
function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length && i < 20_000; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "\n" || ch === "\r") break;
    if (counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  // DELIMITERS order is the tie-break: a comma wins a draw.
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function tokenize(text: string, delimiter: string): { records: string[][]; unterminatedQuote: boolean; truncated: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // False once anything, including an opening quote, has been read for the current field:
  // a quote only opens a quoted field when it is the field's first character.
  let fieldStart = true;
  let truncated = false;
  const n = text.length;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStart = true;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      endRecord();
      // One more than the limit is kept so the caller can tell "exactly at the limit" from "over it".
      if (records.length > CSV_LIMITS.maxRows + 1) {
        truncated = true;
        return { records, unterminatedQuote: false, truncated };
      }
      continue;
    }
    // A quote in the middle of an unquoted field (5'10" tall) is ordinary text.
    field += ch;
    fieldStart = false;
    i++;
  }
  // The last record has no trailing newline; an entirely empty tail is not a record.
  if (field !== "" || record.length > 0 || !fieldStart) endRecord();
  return { records, unterminatedQuote: quoted, truncated };
}

function cleanCell(value: string): string {
  // NUL cannot be stored in Postgres text; the other invisibles only cause mismatches.
  const cleaned = value.replace(/[\u0000﻿​]/g, "").replace(/ /g, " ").trim();
  return cleaned.length > CSV_LIMITS.maxCellLength ? cleaned.slice(0, CSV_LIMITS.maxCellLength) : cleaned;
}

/**
 * Parses CSV text or bytes. Handles quoted fields, doubled quotes, line breaks
 * inside quotes, CRLF / LF / CR endings, a byte-order mark, Excel's `sep=` hint
 * and comma, semicolon, tab or pipe delimiters (detected from the header row).
 *
 * Throws ServiceError("invalid") only when there is nothing usable: an empty
 * file, a file that is not text, or one over the size limit.
 */
export function parseCsv(input: string | Uint8Array): ParsedCsv {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    throw new ServiceError("invalid", "No spreadsheet was received. Choose a CSV file and try again.");
  }
  const size = typeof input === "string" ? input.length : input.byteLength;
  if (size > CSV_LIMITS.maxBytes) {
    throw new ServiceError("invalid", "That file is larger than 5 MB. Split it into smaller files and import them one at a time.");
  }
  let text = decode(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Binary content decodes to text full of NULs; a real CSV has none.
  if ((text.slice(0, 4000).match(/\u0000/g)?.length ?? 0) > 8) {
    throw new ServiceError("invalid", "That file is not a CSV file. Save your spreadsheet as CSV and upload that file.");
  }
  const warnings: string[] = [];

  let delimiter: CsvDelimiter | null = null;
  // Excel writes "sep=;" as a first line to announce the delimiter.
  const hint = /^sep=(.)\r?\n/i.exec(text);
  if (hint) {
    text = text.slice(hint[0].length);
    if ((DELIMITERS as readonly string[]).includes(hint[1])) delimiter = hint[1] as CsvDelimiter;
  }
  // Leading blank lines would otherwise be read as the header.
  text = text.replace(/^(?:[ \t]*\r?\n)+/, "");
  if (text.trim() === "") {
    throw new ServiceError("invalid", "That file is empty. Add a header row and at least one client, then upload it again.");
  }
  delimiter ??= detectDelimiter(text);

  const { records, unterminatedQuote, truncated } = tokenize(text, delimiter);
  if (unterminatedQuote) {
    warnings.push("A quoted value was never closed, so the end of the file was read as one value. Check the last row.");
  }

  const rawHeaders = (records[0] ?? []).map(cleanCell);
  while (rawHeaders.length > 0 && rawHeaders[rawHeaders.length - 1] === "") rawHeaders.pop();
  if (rawHeaders.length === 0) {
    throw new ServiceError("invalid", "The first row has no column headings. Add a header row such as Name, Email, Company and upload the file again.");
  }
  if (rawHeaders.length > CSV_LIMITS.maxColumns) {
    throw new ServiceError("invalid", `That file has more than ${CSV_LIMITS.maxColumns} columns. Remove the columns you do not need and upload it again.`);
  }
  const headers = rawHeaders.map((h, i) => h || `Column ${i + 1}`);

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let overflowRows = 0;
  let overLimit = truncated;
  for (let r = 1; r < records.length; r++) {
    const cells = records[r].map(cleanCell);
    if (cells.every((c) => c === "")) continue;
    if (rows.length >= CSV_LIMITS.maxRows) {
      overLimit = true;
      break;
    }
    if (cells.slice(headers.length).some((c) => c !== "")) overflowRows++;
    const row = cells.slice(0, headers.length);
    while (row.length < headers.length) row.push("");
    rows.push(row);
    rowNumbers.push(r + 1);
  }
  if (overflowRows > 0) {
    warnings.push(
      `${overflowRows} ${overflowRows === 1 ? "row has" : "rows have"} more values than there are column headings; the extra values were ignored. A value containing a ${delimiterName(delimiter)} must be wrapped in double quotes.`,
    );
  }
  if (overLimit) warnings.push(`Only the first ${CSV_LIMITS.maxRows} rows were read.`);
  return { headers, rows, rowNumbers, delimiter, warnings };
}

function delimiterName(d: CsvDelimiter): string {
  return d === "," ? "comma" : d === ";" ? "semicolon" : d === "\t" ? "tab" : "vertical bar";
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export type FileColumn =
  | "clientName"
  | "clientEmail"
  | "clientCompany"
  | "clientTitle"
  | "clientPhone"
  | "description"
  | "reference"
  | "externalId";

/** One row of an import, shaped like the input of createFile. */
export interface ImportRow {
  /** Spreadsheet row number, echoed back in the import result. */
  row?: number;
  clientName?: unknown;
  clientEmail?: unknown;
  clientCompany?: unknown;
  clientTitle?: unknown;
  clientPhone?: unknown;
  description?: unknown;
  reference?: unknown;
  externalId?: unknown;
  data?: unknown;
}

export interface ColumnMapping {
  header: string;
  index: number;
  /** A file field, a custom value (`data:<key>`), part of a split name, or null when the column is ignored. */
  target: FileColumn | "firstName" | "lastName" | `data:${string}` | null;
}

export interface MappedRows {
  columns: ColumnMapping[];
  /** Required file fields no column supplies, as plain labels ("Client name", "Client email"). */
  missing: string[];
  /** Headers that were ignored, with the reason in `warnings`. */
  unmapped: string[];
  /** Headers kept as custom values on each file. */
  dataColumns: string[];
  rows: ImportRow[];
  warnings: string[];
  /** A sentence to show when the import cannot run, or null when it can. */
  error: string | null;
}

export const MAX_DATA_COLUMNS = 50;
const MAX_DATA_KEY_LENGTH = 60;

/**
 * The stored form of a custom value's name: "Policy Number", "policy-number" and
 * " POLICY  NUMBER " are all `policy_number`. A prefill field bound to
 * `custom:<key>` must look the key up through this same function.
 */
export function normalizeDataKey(label: unknown): string {
  if (typeof label !== "string" && typeof label !== "number") return "";
  const key = String(label)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return key.slice(0, MAX_DATA_KEY_LENGTH).replace(/_+$/, "");
}

/** Headers are compared with case, spacing and punctuation removed: "E-mail Address" -> "emailaddress". */
function headerKey(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/#/g, "number")
    .replace(/[^a-z0-9]+/g, "");
}

const ALIASES: Record<FileColumn | "firstName" | "lastName", readonly string[]> = {
  clientName: [
    "name", "clientname", "client", "fullname", "clientfullname", "customer", "customername", "customerfullname",
    "contact", "contactname", "signer", "signername", "recipient", "recipientname", "insured", "insuredname",
    "homeowner", "homeownername", "patient", "patientname", "tenant", "tenantname", "borrower", "borrowername",
  ],
  clientEmail: [
    "email", "emailaddress", "clientemail", "clientemailaddress", "mail", "customeremail", "customeremailaddress",
    "contactemail", "signeremail", "recipientemail", "emailid", "primaryemail", "emailaddr",
  ],
  clientCompany: [
    "company", "companyname", "clientcompany", "organization", "organisation", "organizationname", "organisationname",
    "business", "businessname", "employer", "firm", "org", "customercompany",
  ],
  clientTitle: ["title", "jobtitle", "clienttitle", "position", "role", "designation"],
  clientPhone: [
    "phone", "phonenumber", "phoneno", "telephone", "telephonenumber", "tel", "mobile", "mobilenumber", "mobilephone",
    "cell", "cellphone", "cellnumber", "clientphone", "contactnumber", "contactphone", "customerphone",
  ],
  description: [
    "description", "notes", "note", "details", "filedescription", "jobdescription", "matterdescription",
    "casedescription", "projectdescription", "summary", "comments", "comment", "scope", "scopeofwork",
  ],
  reference: [
    "reference", "ref", "refno", "refnumber", "referenceno", "referencenumber", "file", "fileno", "filenumber",
    "filenum", "fileref", "filereference", "fileid", "matter", "matterno", "matternumber", "matterref", "matterid",
    "case", "caseno", "casenumber", "caseref", "caseid", "job", "jobno", "jobnumber", "jobref", "jobid",
  ],
  externalId: ["externalid", "id", "extid", "recordid", "sourceid", "crmid", "externalreference", "externalref"],
  firstName: ["firstname", "first", "givenname", "forename", "clientfirstname", "customerfirstname", "contactfirstname"],
  lastName: ["lastname", "last", "surname", "familyname", "clientlastname", "customerlastname", "contactlastname"],
};

const TARGET_BY_KEY = new Map<string, FileColumn | "firstName" | "lastName">();
for (const [target, keys] of Object.entries(ALIASES) as [FileColumn | "firstName" | "lastName", readonly string[]][]) {
  for (const key of keys) TARGET_BY_KEY.set(key, target);
}

/** Example headings shown when a required column is missing. */
export const COLUMN_HINTS = {
  clientName: 'a column named "Name" or "Client name" (or "First name" and "Last name")',
  clientEmail: 'a column named "Email"',
} as const;

/** "Jane Doe <jane@example.com>" and "mailto:jane@example.com" are common in exported contact lists. */
function tidyEmail(value: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const email = angle ? angle[1] : value;
  return email.replace(/^mailto:/i, "").trim();
}

/**
 * Works out which column feeds which file field from the header names alone, and
 * reshapes every row into createFile input. Columns it does not recognise are kept
 * as custom values on the file (available to prefill fields), never dropped silently.
 * Never throws; when the import cannot run, `error` says why.
 */
export function mapRows(headersInput: unknown, rowsInput: unknown, rowNumbers?: readonly number[]): MappedRows {
  const headers = Array.isArray(headersInput) ? headersInput.map((h) => (typeof h === "string" ? h.trim() : h == null ? "" : String(h).trim())) : [];
  const rows = Array.isArray(rowsInput) ? rowsInput.filter((r): r is unknown[] => Array.isArray(r)) : [];
  const warnings: string[] = [];
  const unmapped: string[] = [];
  const dataColumns: string[] = [];
  const columns: ColumnMapping[] = [];
  const taken = new Map<string, string>();
  const dataKeys = new Set<string>();

  const asData = (header: string, index: number): ColumnMapping => {
    const key = normalizeDataKey(header);
    if (!key) {
      unmapped.push(header || `Column ${index + 1}`);
      warnings.push(`Column ${index + 1} has no heading, so it was ignored.`);
      return { header, index, target: null };
    }
    if (dataKeys.has(key)) {
      unmapped.push(header);
      warnings.push(`There is more than one column named "${header}". Only the first one is imported.`);
      return { header, index, target: null };
    }
    if (dataKeys.size >= MAX_DATA_COLUMNS) {
      unmapped.push(header);
      return { header, index, target: null };
    }
    dataKeys.add(key);
    dataColumns.push(header);
    return { header, index, target: `data:${key}` };
  };

  headers.forEach((header, index) => {
    // Placeholder names the parser gives to blank headings carry no meaning.
    if (!header || /^Column \d+$/.test(header)) {
      const hasValues = rows.some((r) => typeof r[index] === "string" && (r[index] as string).trim() !== "");
      if (hasValues) {
        unmapped.push(header || `Column ${index + 1}`);
        warnings.push(`Column ${index + 1} has no heading, so it was ignored.`);
      }
      columns.push({ header, index, target: null });
      return;
    }
    const target = TARGET_BY_KEY.get(headerKey(header));
    if (target && !taken.has(target)) {
      taken.set(target, header);
      columns.push({ header, index, target });
      return;
    }
    if (target) {
      warnings.push(`"${taken.get(target)}" and "${header}" both look like the ${LABELS[target].toLowerCase()}. "${taken.get(target)}" is used; "${header}" is kept as an extra value.`);
    }
    columns.push(asData(header, index));
  });

  const overflow = columns.filter((c) => c.target === null && c.header && !/^Column \d+$/.test(c.header) && normalizeDataKey(c.header) && !dataKeys.has(normalizeDataKey(c.header)));
  if (overflow.length > 0) {
    warnings.push(`Only ${MAX_DATA_COLUMNS} extra columns can be kept on a file. Ignored: ${overflow.map((c) => `"${c.header}"`).slice(0, 10).join(", ")}${overflow.length > 10 ? " and more" : ""}.`);
  }

  const hasFullName = taken.has("clientName");
  const hasSplitName = taken.has("firstName") || taken.has("lastName");
  const missing: string[] = [];
  if (!hasFullName && !hasSplitName) missing.push(LABELS.clientName);
  if (!taken.has("clientEmail")) missing.push(LABELS.clientEmail);

  let error: string | null = null;
  if (headers.length === 0) {
    error = "The spreadsheet has no column headings. Add a header row such as Name, Email, Company.";
  } else if (missing.length > 0) {
    const need = [
      !hasFullName && !hasSplitName ? COLUMN_HINTS.clientName : null,
      !taken.has("clientEmail") ? COLUMN_HINTS.clientEmail : null,
    ].filter(Boolean);
    const found = headers.filter(Boolean).slice(0, 12).map((h) => `"${h}"`).join(", ");
    error = `The spreadsheet needs ${need.join(" and ")}. The headings found were: ${found || "none"}. Rename the right column and upload the file again.`;
  } else if (rows.length === 0) {
    error = "The spreadsheet has a header row but no clients under it. Add at least one row and upload it again.";
  }

  const cell = (row: unknown[], index: number): string => {
    const v = row[index];
    return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  };

  const mapped: ImportRow[] = rows.map((row, r) => {
    const out: ImportRow = { row: rowNumbers?.[r] ?? r + 2 };
    const data: [string, string][] = [];
    let first = "";
    let last = "";
    for (const col of columns) {
      if (col.target === null) continue;
      const value = cell(row, col.index);
      if (value === "") continue;
      if (col.target === "firstName") first = value;
      else if (col.target === "lastName") last = value;
      else if (col.target.startsWith("data:")) data.push([col.target.slice(5), value]);
      else if (col.target === "clientEmail") out.clientEmail = tidyEmail(value);
      else out[col.target as FileColumn] = value;
    }
    // A full-name column wins; the split columns only fill in when it is blank for this row.
    if (!out.clientName && (first || last)) out.clientName = `${first} ${last}`.trim();
    if (data.length > 0) out.data = Object.fromEntries(data);
    return out;
  });

  return { columns, missing, unmapped, dataColumns, rows: mapped, warnings, error };
}

const LABELS: Record<FileColumn | "firstName" | "lastName", string> = {
  clientName: "Client name",
  clientEmail: "Client email",
  clientCompany: "Company",
  clientTitle: "Title",
  clientPhone: "Phone",
  description: "Description",
  reference: "File reference",
  externalId: "External ID",
  firstName: "First name",
  lastName: "Last name",
};

/** Label for a mapped column, for the import preview ("Email address" -> "Client email"). */
export function describeTarget(target: ColumnMapping["target"]): string {
  if (target === null) return "Ignored";
  if (target.startsWith("data:")) return `Extra value (${target.slice(5)})`;
  return LABELS[target as keyof typeof LABELS] ?? "Ignored";
}
