/**
 * Contract for the document engine (src/lib/pdf). The engine is pure: bytes in,
 * bytes out, no database or network access except the optional AI detector.
 * Everything here must run in a Node serverless function (no native binaries,
 * no headless browser, no canvas).
 */
import type { Field, FieldValues, PageInfo, DetectionMeta } from "@/lib/types";

export type SourceKind = "pdf" | "docx" | "text" | "image" | "html";

/** Thrown for input the engine cannot turn into a signable PDF. `message` is safe
 *  to show to the person who uploaded the file and says what to do next. */
export class DocumentError extends Error {
  constructor(
    public code:
      | "empty"
      | "too_large"
      | "too_many_pages"
      | "unsupported_type"
      | "password_protected"
      | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface IngestInput {
  bytes: Uint8Array;
  filename: string;
  /** Browser-reported type; never trusted on its own, content is sniffed. */
  mimeType?: string;
}

export interface IngestResult {
  /** Normalized PDF: unencrypted, form fields flattened, saved by pdf-lib so it
   *  can be reliably modified later. */
  pdf: Uint8Array;
  pages: PageInfo[];
  sourceKind: SourceKind;
  /** Suggested agreement name derived from the document title or filename. */
  title: string;
  /** Fields recovered from interactive PDF form widgets before flattening. */
  formFields: Field[];
  /** Plain-language notes for the uploader (e.g. "Converted from Word; check the layout"). */
  warnings: string[];
}

/** A run of text with its position, in the same top-left fractional page space as Field. */
export interface TextItem {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExtractedText {
  items: TextItem[];
  /** Text per page in reading order. */
  pageText: string[];
  /** True when the document has (almost) no extractable text: a scan or photo. */
  scanned: boolean;
}

export interface DetectOptions {
  /** Fields recovered from PDF form widgets at ingest; they take priority. */
  formFields?: Field[];
  /** Printed on the appended signature page and used to tell the two parties apart. */
  companyName?: string;
  /** Set false to skip the AI pass even when a key is configured. */
  useAI?: boolean;
}

export interface DetectionResult {
  /** The PDF to store. Identical to the input unless a signature page was appended. */
  pdf: Uint8Array;
  pages: PageInfo[];
  fields: Field[];
  meta: DetectionMeta;
}

/** One signer's entry on the certificate page. */
export interface CertificateSigner {
  role: "client" | "company";
  name: string;
  email: string;
  signedAt: Date;
  consentAt?: Date | null;
  ip?: string | null;
  userAgent?: string | null;
  /** e.g. "Signed via emailed link" or "Saved signature applied automatically". */
  method: string;
}

export interface CertificateEvent {
  at: Date;
  /** Plain sentence, e.g. "Agreement emailed to jane@example.com". */
  description: string;
}

export interface CertificateData {
  envelopeId: string;
  agreementName: string;
  fileReference: string;
  orgName: string;
  /** SHA-256 of the unsigned document the parties were shown. */
  originalSha256: string;
  signers: CertificateSigner[];
  events: CertificateEvent[];
  completedAt: Date;
  /** Public URL where anyone holding the PDF can verify it. */
  verifyUrl?: string;
}

export interface SealInput {
  pdf: Uint8Array;
  fields: Field[];
  /** Merged values from prefill and every signer, keyed by field id. */
  values: FieldValues;
  certificate: CertificateData;
}

/**
 * Something the sealed record shows differently from what was entered. Sealing
 * still succeeds; the caller should record these and tell the sender.
 */
export interface SealWarning {
  /** characters_replaced: text held characters the document font cannot draw; they print as placeholder boxes.
   *  image_skipped: a signature or initials image was left out because too many different images were supplied. */
  code: "characters_replaced" | "image_skipped";
  /** The field concerned, or absent when the certificate page is. */
  fieldId?: string;
  /** Plain sentence, safe to show to the sender. */
  message: string;
}

export interface SealResult {
  pdf: Uint8Array;
  sha256: string;
  /** Empty when the sealed document shows every value exactly as entered. */
  warnings: SealWarning[];
}

/**
 * The engine's public surface, exported from "@/lib/pdf".
 *
 *   ingestDocument(input)                      -> IngestResult      (throws DocumentError)
 *   ingestText(text, title)                    -> IngestResult
 *   extractText(pdf)                           -> ExtractedText
 *   detectFields(pdf, options)                 -> DetectionResult   (never throws; always returns a signable result)
 *   appendSignaturePage(pdf, { companyName, includeCompany }) -> { pdf, pages, fields }
 *   stampFields(pdf, fields, values)           -> Uint8Array        (values drawn onto the pages; used for previews)
 *   sealDocument(input)                        -> SealResult        (stamps, appends certificate, hashes; lists what could not be shown as entered)
 *   getPages(pdf)                              -> PageInfo[]
 */
export type { Field, FieldValues, PageInfo, DetectionMeta };
