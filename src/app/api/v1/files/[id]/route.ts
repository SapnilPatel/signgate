import { apiJson, apiRoute } from "@/lib/api/http";
import { EmptyQuery, UpdateFileBody } from "@/lib/api/schemas";
import { apiChangedFields, apiFile, apiFileDetail } from "@/lib/api/shapes";
import { getFile, updateFile, type UpdateFilePatch } from "@/lib/services/files";

/** GET /api/v1/files/{id}: one file with every agreement sent for it, newest first. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params, query }) => {
  query(EmptyQuery);
  return apiJson(apiFileDetail(await getFile(actor, params.id)));
});

const PATCH_KEYS = {
  client_name: "clientName",
  client_email: "clientEmail",
  client_company: "clientCompany",
  client_title: "clientTitle",
  client_phone: "clientPhone",
  description: "description",
  reference: "reference",
  data: "data",
} as const;

/**
 * PATCH /api/v1/files/{id}: changes the details given and leaves the rest. It never
 * touches an agreement already sent; `reissue_suggested` says when one should be re-sent.
 */
export const PATCH = apiRoute<{ id: string }>(async ({ actor, params, body, meta }) => {
  const input = body(UpdateFileBody);
  const patch: UpdateFilePatch = {};
  for (const [from, to] of Object.entries(PATCH_KEYS) as [keyof typeof PATCH_KEYS, (typeof PATCH_KEYS)[keyof typeof PATCH_KEYS]][]) {
    // Only what was sent: a key that is absent must not clear a value.
    if (input[from] !== undefined) patch[to] = input[from];
  }
  const result = await updateFile(actor, params.id, patch, meta);
  return apiJson({
    file: apiFile(result.file),
    changed: apiChangedFields(result.changed),
    outstanding_envelope_id: result.outstandingEnvelope?.id ?? null,
    reissue_suggested: result.reissueSuggested,
  });
});
