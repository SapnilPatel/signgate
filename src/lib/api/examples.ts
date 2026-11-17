/**
 * The example requests and responses shown in the API reference.
 *
 * Nothing here is typed out as JSON. Each response is made by passing a fixed, made-up
 * row through the same functions the routes use (src/lib/api/shapes.ts), so the
 * documentation cannot show a field the API does not return, or miss one it does.
 * tests/unit/api-docs.test.ts also checks these against live responses.
 */
import type { Envelope, FileRow, Org } from "@/lib/db/schema";
import { deliveryReason, type SignerView } from "@/lib/services/envelopes";
import { toPublicFile } from "@/lib/services/files";
import { webhookPayload } from "@/lib/services/signing";
import type { TemplateSummary } from "@/lib/services/templates";
import { ApiError, type ApiErrorBody } from "./errors";
import { validate } from "./http";
import { CreateFileBody } from "./schemas";
import { apiAgreement, apiAgreementOutcome, apiChangedFields, apiCompany, apiEnvelope, apiFile, apiFileDetail } from "./shapes";

export const EXAMPLE_ORIGIN = "https://signgate.example";
export const EXAMPLE_KEY = "sg_live_YOUR_KEY";

const at = (iso: string) => new Date(iso);
const SIGNING_URL = `${EXAMPLE_ORIGIN}/sign/9hT2c4QmVx0sLr7wBn3KdYp6ZaEu1JfG5oNiXt8MvCb`;

const org: Pick<Org, "id" | "name" | "legalName"> = { id: "org_8fK2mQx71LbTnA4c", name: "Harbor Street Law", legalName: "Harbor Street Law LLP" };

const fileRow: FileRow = {
  id: "file_3vN8yRk20PdWqS6h",
  orgId: org.id,
  reference: "F-2026-0142",
  externalId: "case-88213",
  clientName: "Jordan Avery",
  clientEmail: "jordan.avery@example.com",
  clientCompany: "Avery Imports Ltd",
  clientTitle: "Director",
  clientPhone: null,
  description: "Commercial lease review",
  data: { matter: "Lease review", fee: "2,400.00" },
  source: "api",
  agreementStatus: "out_for_signature",
  archivedAt: null,
  createdBy: null,
  createdAt: at("2026-11-16T15:04:05.000Z"),
  updatedAt: at("2026-11-16T15:04:06.000Z"),
};

const envelopeRow: Envelope = {
  id: "env_6cB1tHz93MgXeU5j",
  orgId: org.id,
  fileId: fileRow.id,
  templateId: "tpl_5pL9wDf46JrYaC2n",
  templateName: "Client engagement agreement",
  templateVersion: 4,
  pdfBlobId: "blob_example",
  pdfSha256: "5d3c1f0a9b7e4c2d8a6f1e0b3c5d7a9f2e4b6c8d0a1f3e5b7c9d2a4f6e8b0c1d",
  pages: [],
  fields: [],
  prefill: {},
  status: "sent",
  sentAt: at("2026-11-16T15:04:06.000Z"),
  completedAt: null,
  expiresAt: at("2026-12-16T15:04:06.000Z"),
  declineReason: null,
  voidReason: null,
  finalBlobId: null,
  finalSha256: null,
  reminderCount: 0,
  lastReminderAt: null,
  nextReminderAt: at("2026-11-19T15:04:06.000Z"),
  createdBy: null,
  createdAt: at("2026-11-16T15:04:06.000Z"),
  updatedAt: at("2026-11-16T15:04:06.000Z"),
};

function signer(over: Partial<SignerView>): SignerView {
  return {
    id: "sgn_2aE7uGv58KcZrP1m",
    envelopeId: envelopeRow.id,
    orgId: org.id,
    role: "client",
    order: 1,
    name: fileRow.clientName,
    email: fileRow.clientEmail,
    userId: null,
    status: "sent",
    consentAt: null,
    viewedAt: null,
    signedAt: null,
    ip: null,
    userAgent: null,
    createdAt: envelopeRow.createdAt,
    signingUrl: SIGNING_URL,
    isTurn: true,
    ...over,
  };
}

const clientSigner = signer({});
// The company signer's link is never given to an API key, whatever the envelope's state.
const companySigner = signer({ id: "sgn_7nW3xJb04TfHsQ9k", role: "company", order: 2, name: "Morgan Ellis", email: "morgan@harborstreet.example", status: "waiting", signingUrl: null, isTurn: false });

const completedEnvelope: Envelope = {
  ...envelopeRow,
  status: "completed",
  completedAt: at("2026-11-17T09:31:44.000Z"),
  finalBlobId: "blob_example_signed",
  finalSha256: "c2a94e7f1b3d5069a8e2f4c6b0d1e3a5f7092b4d6c8e0a1f3b5d7c9e2a4f6b8d",
  nextReminderAt: null,
  updatedAt: at("2026-11-17T09:31:44.000Z"),
};
const signedFile: FileRow = { ...fileRow, agreementStatus: "signed", updatedAt: completedEnvelope.updatedAt };
const signedSigners = [
  signer({ status: "signed", viewedAt: at("2026-11-16T18:12:09.000Z"), signedAt: at("2026-11-16T18:15:37.000Z"), signingUrl: null, isTurn: false }),
  { ...companySigner, status: "signed" as const, viewedAt: at("2026-11-17T09:30:02.000Z"), signedAt: at("2026-11-17T09:31:40.000Z") },
];

const template: TemplateSummary = {
  id: "tpl_5pL9wDf46JrYaC2n",
  orgId: org.id,
  name: "Client engagement agreement",
  status: "active",
  isDefault: true,
  sourceBlobId: null,
  pdfBlobId: "blob_example",
  pages: [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ] as TemplateSummary["pages"],
  fields: [],
  detection: null,
  version: 4,
  intakeToken: null,
  createdBy: null,
  createdAt: at("2026-09-02T10:00:00.000Z"),
  updatedAt: at("2026-10-28T14:22:10.000Z"),
  sentCount: 141,
  signedCount: 127,
  readiness: { ready: true, problems: [] },
};

const sentOutcome = apiAgreementOutcome({ sent: true, envelopeId: envelopeRow.id, delivery: "emailed", signingUrl: SIGNING_URL });
const envelope = apiEnvelope(envelopeRow, [clientSigner, companySigner]);

export const EXAMPLE_IDS = { file: fileRow.id, envelope: envelopeRow.id, agreement: template.id } as const;

export const EXAMPLE_BODIES = {
  createFile: {
    client_name: fileRow.clientName,
    client_email: fileRow.clientEmail,
    client_company: fileRow.clientCompany,
    client_title: fileRow.clientTitle,
    description: fileRow.description,
    external_id: fileRow.externalId,
    data: fileRow.data,
  },
  quickStart: { client_name: fileRow.clientName, client_email: fileRow.clientEmail, external_id: fileRow.externalId },
  updateFile: { client_email: "j.avery@example.com" },
  send: { agreement_id: template.id },
  resend: { replace: true },
  voidEnvelope: { reason: "The client asked for different terms" },
} as const;

export const EXAMPLE_RESPONSES = {
  me: { company: apiCompany(org), api_key: { id: "key_4dR6sVn15HqBwT8f" }, default_agreement: apiAgreement(template) },
  createFile: { file: apiFile(fileRow), created: true, agreement: sentOutcome },
  createFileNotEmailed: {
    file: apiFile(fileRow),
    created: true,
    agreement: apiAgreementOutcome({
      sent: true,
      envelopeId: envelopeRow.id,
      delivery: "email_failed",
      deliveryReason: deliveryReason("email_failed"),
      signingUrl: SIGNING_URL,
    }),
  },
  listFiles: { files: [apiFile(fileRow)], page: 1, per_page: 25, total: 1, page_count: 1, next_page: null },
  getFile: apiFileDetail({ file: fileRow, envelopes: [{ ...envelopeRow, signers: [clientSigner, companySigner], canCountersign: false }] }),
  getFileSigned: apiFileDetail({ file: signedFile, envelopes: [{ ...completedEnvelope, signers: signedSigners, canCountersign: false }] }),
  updateFile: {
    file: apiFile({ ...fileRow, clientEmail: EXAMPLE_BODIES.updateFile.client_email }),
    changed: apiChangedFields(["client email"]),
    outstanding_envelope_id: envelopeRow.id,
    reissue_suggested: true,
  },
  send: { file: apiFile(fileRow), agreement: sentOutcome },
  archive: { file: apiFile({ ...fileRow, agreementStatus: "no_agreement", archivedAt: at("2026-11-20T08:00:00.000Z"), updatedAt: at("2026-11-20T08:00:00.000Z") }), voided_envelopes: 1 },
  agreements: { agreements: [apiAgreement(template)] },
  getEnvelope: { envelope },
  getEnvelopeCompleted: { envelope: apiEnvelope(completedEnvelope, signedSigners) },
  voidEnvelope: {
    envelope: apiEnvelope({ ...envelopeRow, status: "voided", voidReason: EXAMPLE_BODIES.voidEnvelope.reason, nextReminderAt: null }, [{ ...clientSigner, signingUrl: null }, companySigner]),
    already_voided: false,
  },
  remind: { reminded: true, to: fileRow.clientEmail, delivery: "emailed", delivery_note: null, signing_url: SIGNING_URL, envelope },
} as const;

/** Bodies of webhook deliveries, in the shape src/lib/services/webhooks.ts posts them. */
export const EXAMPLE_WEBHOOKS = {
  completed: {
    id: "whd_1bM5kPy82NdGvR3x",
    event: "agreement.completed",
    created_at: "2026-11-17T09:31:44.000Z",
    data: webhookPayload({ envelope: completedEnvelope, file: signedFile, signers: signedSigners }, "completed", {
      completedAt: "2026-11-17T09:31:44.000Z",
      signedDocumentSha256: completedEnvelope.finalSha256,
    }),
  },
  fileCreated: {
    id: "whd_9sQ4hLc37VxEoK6a",
    event: "file.created",
    created_at: "2026-11-16T15:04:05.000Z",
    data: { file: toPublicFile({ ...fileRow, agreementStatus: "no_agreement", updatedAt: fileRow.createdAt }) },
  },
};

export const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * The webhook verification examples, kept as text here so the tests can run them
 * against a signature made by the real signing code.
 */
export const VERIFY_NODE = `const crypto = require("node:crypto");

// rawBody: the request body exactly as received, before JSON.parse.
// header:  the X-Signgate-Signature header, for example "t=1763371904,v1=5f2c...".
function verifySigngateWebhook(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.trim().split("=")));
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(timestamp + "." + rawBody).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}`;

export const VERIFY_PYTHON = `import hashlib
import hmac
import time

# raw_body: the request body exactly as received (bytes), before parsing the JSON.
# header:   the X-Signgate-Signature header, for example "t=1763371904,v1=5f2c...".
def verify_signgate_webhook(secret: str, header: str, raw_body: bytes, tolerance_seconds: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    if not parts.get("t", "").isdigit() or "v1" not in parts:
        return False
    if abs(time.time() - int(parts["t"])) > tolerance_seconds:
        return False
    signed = parts["t"].encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"].lower())`;

/** A real validation failure: a misspelled field, run through the validator the routes use. */
export const EXAMPLE_ERROR: ApiErrorBody = (() => {
  try {
    validate(CreateFileBody, { client_name: fileRow.clientName, clientEmail: fileRow.clientEmail }, "body");
  } catch (err) {
    if (err instanceof ApiError) return { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } };
  }
  throw new Error("The example request was expected to fail validation.");
})();
