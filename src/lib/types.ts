/**
 * Shared domain types. This file is the contract between the document engine,
 * the services layer and the UI. It has no runtime dependencies.
 */

/** Who supplies a field's value.
 *  - prefill: filled automatically from the file when the agreement is sent
 *  - client:  filled by the client while signing
 *  - company: filled by the company's countersigner */
export type FieldRole = "prefill" | "client" | "company";

export type FieldType =
  | "signature" // PNG data URL
  | "initials" // PNG data URL
  | "date_signed" // set automatically at signing, never typed
  | "full_name"
  | "title"
  | "company"
  | "email"
  | "text"
  | "date" // a date the signer or the file supplies (e.g. effective date)
  | "checkbox";

/** Values a prefill field can be bound to. `custom:<key>` reads file.data[key]. */
export type MergeKey =
  | "client_name"
  | "client_email"
  | "client_company"
  | "client_title"
  | "client_phone"
  | "file_reference"
  | "file_description"
  | "company_name"
  | "today"
  | `custom:${string}`;

/**
 * A field placed on the agreement.
 *
 * Geometry is expressed as fractions (0..1) of the page AS DISPLAYED: after the
 * page's rotation and crop box are applied, with the origin at the TOP-LEFT.
 * This is exactly what a pdf.js viewport renders, so the browser editor can
 * position overlays with percentages and never needs PDF coordinates.
 */
export interface Field {
  id: string;
  /** Zero-based page index. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  role: FieldRole;
  required: boolean;
  /** Short human label shown to the signer, e.g. "Client signature". */
  label: string;
  /** For prefill fields: where the value comes from. */
  mergeKey?: MergeKey;
  /** How the field got here; shown in the editor so people know what to double-check. */
  source: "detected" | "manual" | "appended" | "form";
  /** Detector confidence 0..1, absent for manual fields. */
  confidence?: number;
}

/** Field id -> value. Signatures and initials are PNG data URLs; checkboxes are booleans. */
export type FieldValues = Record<string, string | boolean>;

/** Size of a page as displayed, in PDF points. */
export interface PageInfo {
  width: number;
  height: number;
}

export interface DetectionMeta {
  /** Which strategy produced the fields that were kept. */
  method: "form" | "ai" | "heuristic" | "appended" | "none";
  /** True when no usable signature location was found in the document and a
   *  signature page was appended so the agreement can always be signed. */
  signaturePageAppended: boolean;
  /** True when the PDF has no text layer (a scan). */
  scanned: boolean;
  /** Things the sender should know, in plain language. */
  notes: string[];
  detectedAt: string;
}

export interface OrgSettings {
  /** Hex colour used on the signing page and emails. */
  brandColor?: string;
  /** PNG/JPEG/SVG data URL. */
  logo?: string;
  /** Replies to agreement emails go here. */
  replyToEmail?: string;
  /** Days between automatic reminders; 0 turns reminders off. Default 2. */
  reminderEveryDays?: number;
  /** Maximum automatic reminders per envelope. Default 5. */
  maxReminders?: number;
  /** Days until an unsigned envelope expires; 0 means never. Default 30. */
  expireAfterDays?: number;
  /** Send the default agreement as soon as a file is created. Default true. */
  autoSendOnFileCreate?: boolean;
  /** How the company's side gets signed when the agreement has company fields.
   *  - auto: the designated countersigner's saved signature is applied the moment the client signs
   *  - manual: the countersigner is emailed and signs themselves
   *  Default manual; auto requires a countersigner with a saved signature. */
  countersignMode?: "auto" | "manual";
  /** User id of the default countersigner. */
  countersignerUserId?: string;
  /** Prefix for generated file references, e.g. "F" -> F-2026-0001. */
  fileReferencePrefix?: string;
  /** Extra message included in the signing request email. */
  emailMessage?: string;
  /** IANA time zone name, e.g. "America/Toronto". Dates the company puts on a document
   *  (the agreement date, its countersignature date, the year in a file reference) are
   *  calendar days in this zone. Unset means UTC. */
  timeZone?: string;
}

export const ORG_SETTING_DEFAULTS = {
  brandColor: "#1f3a5f",
  reminderEveryDays: 2,
  maxReminders: 5,
  expireAfterDays: 30,
  autoSendOnFileCreate: true,
  countersignMode: "manual",
  fileReferencePrefix: "F",
} as const satisfies OrgSettings;

/** Field types whose value is an image. */
export const IMAGE_FIELD_TYPES: readonly FieldType[] = ["signature", "initials"];

/** Hard limits enforced on every upload and submission. */
export const LIMITS = {
  /** Largest agreement accepted, in bytes. */
  maxUploadBytes: 25 * 1024 * 1024,
  /** Chunk size for uploads; kept under serverless request body caps. */
  uploadChunkBytes: 3 * 1024 * 1024,
  maxPages: 200,
  maxFieldsPerTemplate: 300,
  /** Largest signature image accepted, in bytes of the decoded PNG. */
  maxSignatureBytes: 300 * 1024,
  maxTextFieldLength: 500,
} as const;
