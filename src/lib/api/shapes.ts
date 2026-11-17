/**
 * The response shapes of the public API. Everything an integrator receives is built
 * here, from the services' own public views (toPublicFile, toPublicEnvelope), so a
 * column added to a table can never appear in a response by accident. Names are
 * snake_case and every key is always present: absent values are null, not missing.
 *
 * The documentation page renders its examples through these same functions.
 */
import type { Envelope, FileRow, Org } from "@/lib/db/schema";
import { toPublicEnvelope, type EnvelopeSummary, type SignerView } from "@/lib/services/envelopes";
import { toPublicFile, type AgreementOutcome, type FileDetail } from "@/lib/services/files";
import type { TemplateSummary } from "@/lib/services/templates";

export function apiFile(row: FileRow) {
  const file = toPublicFile(row);
  return {
    id: file.id,
    reference: file.reference,
    external_id: file.externalId,
    client_name: file.clientName,
    client_email: file.clientEmail,
    client_company: file.clientCompany,
    client_title: file.clientTitle,
    client_phone: file.clientPhone,
    description: file.description,
    data: file.data,
    source: file.source,
    agreement_status: file.agreementStatus,
    cleared_to_start: file.clearedToStart,
    archived_at: file.archivedAt,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
  };
}

type ApiSigner = Pick<SignerView, "id" | "role" | "order" | "name" | "email" | "status" | "viewedAt" | "signedAt"> & { signingUrl?: string | null };

/**
 * An envelope with its signers. A signer's `signing_url` is present while that person
 * can still sign. The company signer's link signs for the company, so the services
 * never hand it to an API key and it is always null here.
 */
export function apiEnvelope(envelope: EnvelopeSummary, signers: readonly ApiSigner[] = []) {
  // toPublicEnvelope reads none of the document snapshot columns a summary leaves out.
  const e = toPublicEnvelope(envelope as Envelope, signers);
  const links = new Map(signers.map((s) => [s.id, s.signingUrl ?? null]));
  return {
    id: e.id,
    file_id: e.fileId,
    agreement_id: e.agreementId,
    agreement_name: e.agreementName,
    agreement_version: e.agreementVersion,
    status: e.status,
    sent_at: e.sentAt,
    completed_at: e.completedAt,
    expires_at: e.expiresAt,
    decline_reason: e.declineReason,
    void_reason: e.voidReason,
    original_sha256: e.originalSha256,
    signed_sha256: e.signedSha256,
    reminder_count: e.reminderCount,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    signers: e.signers.map((s) => ({
      id: s.id,
      role: s.role,
      name: s.name,
      email: s.email,
      status: s.status,
      viewed_at: s.viewedAt,
      signed_at: s.signedAt,
      signing_url: links.get(s.id) ?? null,
    })),
  };
}

/** What happened to the agreement as a result of one request. */
export function apiAgreementOutcome(outcome: AgreementOutcome) {
  return {
    /** True only when this request created and sent a new signing request. */
    sent: outcome.sent,
    envelope_id: outcome.envelopeId ?? null,
    /** How the client was told; anything but "emailed" means the link must be passed on by the caller. */
    delivery: outcome.delivery ?? null,
    delivery_note: outcome.deliveryReason ?? null,
    signing_url: outcome.signingUrl ?? null,
    /** When `sent` is false: why, in words that can be shown to a person. */
    reason: outcome.reason ?? null,
  };
}

const STILL_OPEN: readonly Envelope["status"][] = ["draft", "sent", "viewed", "client_signed"];

/**
 * The agreement currently on a file, in the outcome shape, for requests that did not
 * send anything themselves (a repeated create or a replayed send). The caller still
 * gets the envelope and the link it needs to carry on.
 */
export function currentAgreementOutcome(detail: Pick<FileDetail, "envelopes">, reason: string) {
  const current = detail.envelopes.find((e) => STILL_OPEN.includes(e.status)) ?? detail.envelopes.find((e) => e.status === "completed") ?? null;
  const client = current?.signers.find((s) => s.role === "client");
  return apiAgreementOutcome({
    sent: false,
    ...(current ? { envelopeId: current.id } : {}),
    ...(client?.signingUrl ? { signingUrl: client.signingUrl } : {}),
    reason,
  });
}

export function apiFileDetail(detail: Pick<FileDetail, "file" | "envelopes">) {
  return {
    file: apiFile(detail.file),
    /** Newest first. The first one that is not voided, declined or expired is the agreement in play. */
    envelopes: detail.envelopes.map((e) => apiEnvelope(e, e.signers)),
  };
}

export function apiAgreement(template: TemplateSummary) {
  return {
    id: template.id,
    name: template.name,
    status: template.status,
    /** The agreement sent automatically when a file is created. */
    is_default: template.isDefault,
    version: template.version,
    page_count: template.pages.length,
    /** False when something stops it being sent; `problems` says what, in plain words. */
    ready: template.status === "active" && template.readiness.ready,
    problems: template.readiness.problems.map((p) => ({ code: p.code, message: p.message })),
    sent_count: template.sentCount,
    signed_count: template.signedCount,
    created_at: template.createdAt.toISOString(),
    updated_at: template.updatedAt.toISOString(),
  };
}

export function apiCompany(org: Pick<Org, "id" | "name" | "legalName">) {
  return { id: org.id, name: org.name, legal_name: org.legalName };
}

/** updateFile reports what changed in the words the product's own screens use; the API names the fields. */
const CHANGED_FIELD: Record<string, string> = {
  "client name": "client_name",
  "client email": "client_email",
  company: "client_company",
  title: "client_title",
  phone: "client_phone",
  description: "description",
  reference: "reference",
  "extra values": "data",
};

export function apiChangedFields(changed: readonly string[]): string[] {
  return changed.map((label) => CHANGED_FIELD[label] ?? label.replace(/\s+/g, "_"));
}
