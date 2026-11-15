import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  customType,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import type {
  Field,
  FieldValues,
  PageInfo,
  DetectionMeta,
  OrgSettings,
} from "@/lib/types";

/** Postgres bytea <-> Buffer. PGlite returns Uint8Array, node-postgres returns Buffer. */
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ---------------------------------------------------------------------------
// Tenancy and identity
// ---------------------------------------------------------------------------

/** A company using the product. Every other row hangs off an org. */
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Legal name printed on agreements and the signing certificate. */
  legalName: text("legal_name"),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Always stored lowercased and trimmed. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<"owner" | "admin" | "member">().notNull().default("member"),
    /** PNG data URL of this user's adopted signature, used for countersigning. */
    savedSignature: text("saved_signature"),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_org_idx").on(t.orgId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the cookie token; the raw token never touches the database. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Single-use tokens: password reset and team invitations. */
export const authTokens = pgTable("auth_tokens", {
  /** sha256 of the emailed token. */
  id: text("id").primaryKey(),
  kind: text("kind").$type<"password_reset" | "invite">().notNull(),
  orgId: text("org_id").references(() => orgs.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").$type<"admin" | "member">(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Binary storage
// ---------------------------------------------------------------------------

/** Immutable binary objects (PDFs, original uploads). Stored in Postgres so the
 *  product has a single stateful dependency. */
export const blobs = pgTable(
  "blobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    bytes: bytea("bytes").notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    filename: text("filename"),
    createdAt: createdAt(),
  },
  (t) => [index("blobs_org_idx").on(t.orgId)],
);

/** Parts of an in-progress chunked upload (serverless request bodies are capped
 *  at ~4.5 MB, real agreements can be larger). Assembled into a blob, then deleted. */
export const uploadChunks = pgTable(
  "upload_chunks",
  {
    uploadId: text("upload_id").notNull(),
    idx: integer("idx").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.idx] })],
);

// ---------------------------------------------------------------------------
// Agreements (templates)
// ---------------------------------------------------------------------------

/** The agreement a company has every client sign. Uploaded once, reused on every file. */
export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").$type<"draft" | "active" | "archived">().notNull().default("draft"),
    /** The org's default agreement is the one sent automatically for new files. */
    isDefault: boolean("is_default").notNull().default(false),
    /** Original upload exactly as received (PDF, DOCX, image, text). */
    sourceBlobId: text("source_blob_id").references(() => blobs.id),
    /** Normalized PDF that fields are positioned against. */
    pdfBlobId: text("pdf_blob_id")
      .notNull()
      .references(() => blobs.id),
    pages: jsonb("pages").$type<PageInfo[]>().notNull(),
    fields: jsonb("fields").$type<Field[]>().notNull().default([]),
    detection: jsonb("detection").$type<DetectionMeta>(),
    /** Bumped every time fields or the document change; envelopes record the version they used. */
    version: integer("version").notNull().default(1),
    /** Random token for the public self-serve intake link; null when the link is off. */
    intakeToken: text("intake_token").unique(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("templates_org_idx").on(t.orgId)],
);

// ---------------------------------------------------------------------------
// Files and envelopes
// ---------------------------------------------------------------------------

/** A file is one job or case for one client. */
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Human file number, unique per org. Auto-generated when not supplied. */
    reference: text("reference").notNull(),
    /** Optional caller-supplied id from another system; makes API creates idempotent. */
    externalId: text("external_id"),
    clientName: text("client_name").notNull(),
    clientEmail: text("client_email").notNull(),
    clientCompany: text("client_company"),
    clientTitle: text("client_title"),
    clientPhone: text("client_phone"),
    description: text("description"),
    /** Free-form values available to prefill fields, keyed by merge key. */
    data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
    source: text("source").$type<"manual" | "csv" | "api" | "intake">().notNull().default("manual"),
    /** Denormalized from the latest envelope so lists and the API can filter cheaply.
     *  no_agreement -> out_for_signature -> signed; or declined / needs_attention. */
    agreementStatus: text("agreement_status")
      .$type<"no_agreement" | "out_for_signature" | "awaiting_countersign" | "signed" | "declined" | "needs_attention">()
      .notNull()
      .default("no_agreement"),
    archivedAt: ts("archived_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("files_org_reference_uq").on(t.orgId, t.reference),
    uniqueIndex("files_org_external_uq").on(t.orgId, t.externalId),
    index("files_org_status_idx").on(t.orgId, t.agreementStatus),
    index("files_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export type EnvelopeStatus =
  | "draft" // created but not sent (e.g. email missing or send failed)
  | "sent" // waiting for the client
  | "viewed" // client opened the signing link
  | "client_signed" // client done, waiting for the company countersignature
  | "completed" // everyone signed, final PDF sealed
  | "declined"
  | "voided"
  | "expired";

/** One copy of the agreement sent for signature on one file. Snapshots the template
 *  so later template edits never change what a client was shown or signed. */
export const envelopes = pgTable(
  "envelopes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => templates.id, { onDelete: "set null" }),
    templateName: text("template_name").notNull(),
    templateVersion: integer("template_version").notNull(),
    /** Snapshot of the unsigned PDF and its fields at send time. */
    pdfBlobId: text("pdf_blob_id")
      .notNull()
      .references(() => blobs.id),
    pdfSha256: text("pdf_sha256").notNull(),
    pages: jsonb("pages").$type<PageInfo[]>().notNull(),
    fields: jsonb("fields").$type<Field[]>().notNull(),
    /** Values for role "prefill" fields, resolved from the file when the envelope was created. */
    prefill: jsonb("prefill").$type<FieldValues>().notNull().default({}),
    status: text("status").$type<EnvelopeStatus>().notNull().default("draft"),
    sentAt: ts("sent_at"),
    completedAt: ts("completed_at"),
    expiresAt: ts("expires_at"),
    declineReason: text("decline_reason"),
    voidReason: text("void_reason"),
    /** Sealed, fully signed PDF including the certificate page. */
    finalBlobId: text("final_blob_id").references(() => blobs.id),
    finalSha256: text("final_sha256"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: ts("last_reminder_at"),
    nextReminderAt: ts("next_reminder_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("envelopes_org_status_idx").on(t.orgId, t.status),
    index("envelopes_file_idx").on(t.fileId),
    index("envelopes_reminder_idx").on(t.status, t.nextReminderAt),
  ],
);

/** A person who must sign an envelope. The client always signs first (order 1);
 *  the company countersigner, when the agreement has company fields, signs second. */
export const signers = pgTable(
  "signers",
  {
    id: text("id").primaryKey(),
    envelopeId: text("envelope_id")
      .notNull()
      .references(() => envelopes.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    role: text("role").$type<"client" | "company">().notNull(),
    order: integer("order").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    /** sha256 of the secret in the signing link. Rotated when the link is reissued. */
    tokenHash: text("token_hash").notNull(),
    /** Set for the company signer when it is a team member. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status")
      .$type<"waiting" | "sent" | "viewed" | "signed" | "declined">()
      .notNull()
      .default("waiting"),
    /** Field id -> value, saved as the signer progresses and frozen on signing. */
    values: jsonb("values").$type<FieldValues>().notNull().default({}),
    consentAt: ts("consent_at"),
    viewedAt: ts("viewed_at"),
    signedAt: ts("signed_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("signers_token_uq").on(t.tokenHash),
    index("signers_envelope_idx").on(t.envelopeId),
  ],
);

/** Append-only audit trail. Rows are never updated or deleted by application code. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    fileId: text("file_id").references(() => files.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").references(() => envelopes.id, { onDelete: "cascade" }),
    /** e.g. file.created, envelope.sent, envelope.viewed, signer.consented, signer.signed,
     *  envelope.completed, envelope.declined, envelope.voided, envelope.expired,
     *  reminder.sent, email.failed, link.reissued */
    type: text("type").notNull(),
    actorType: text("actor_type").$type<"system" | "user" | "signer" | "api">().notNull(),
    /** Display label: a name and email, an API key name, or "System". */
    actor: text("actor").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_envelope_idx").on(t.envelopeId, t.createdAt),
    index("events_file_idx").on(t.fileId, t.createdAt),
    index("events_org_idx").on(t.orgId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Integrations and delivery
// ---------------------------------------------------------------------------

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters of the key, shown in the UI so keys can be told apart. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_org_idx").on(t.orgId)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** HMAC-SHA256 signing secret, shown once on creation. */
    secret: text("secret").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_org_idx").on(t.orgId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"pending" | "delivered" | "failed">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    error: text("error"),
    nextAttemptAt: ts("next_attempt_at"),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt)],
);

/** Every email the product tried to send, so a failed delivery is visible, not silent. */
export const emailLog = pgTable(
  "email_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    envelopeId: text("envelope_id").references(() => envelopes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    status: text("status").$type<"sent" | "failed" | "skipped">().notNull(),
    providerId: text("provider_id"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("email_log_envelope_idx").on(t.envelopeId)],
);

/** Fixed-window counters for rate limiting; works across serverless instances. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: ts("reset_at").notNull(),
});

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type Signer = typeof signers.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
