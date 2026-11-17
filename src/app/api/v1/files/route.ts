import { ApiError, apiJson, apiRoute, type ApiContext } from "@/lib/api/http";
import { CreateFileBody, ListFilesQuery } from "@/lib/api/schemas";
import { apiAgreementOutcome, apiFile, currentAgreementOutcome } from "@/lib/api/shapes";
import { createFile, getFile, listFiles } from "@/lib/services/files";

// Creating a file renders and sends the agreement in the same request.
export const maxDuration = 60;

/** GET /api/v1/files: the company's files, newest first. */
export const GET = apiRoute(async ({ actor, query }) => {
  const input = query(ListFilesQuery);
  const result = await listFiles(actor, {
    q: input.q,
    status: input.status,
    archived: input.archived ?? "false",
    page: input.page,
    pageSize: input.per_page,
  });
  // The service shows the last page when asked for one past the end, which suits a
  // screen. A program paging until it gets an empty list would never stop, so here a
  // page past the end is empty.
  const page = input.page ?? 1;
  const pastEnd = page > result.pageCount;
  return apiJson({
    files: pastEnd ? [] : result.files.map(apiFile),
    page,
    per_page: result.pageSize,
    total: result.total,
    page_count: result.pageCount,
    next_page: page < result.pageCount ? page + 1 : null,
  });
});

async function create({ actor, body, meta }: ApiContext<Record<string, never>>): Promise<Response> {
  const input = body(CreateFileBody);
  const result = await createFile(
    actor,
    {
      clientName: input.client_name,
      clientEmail: input.client_email,
      clientCompany: input.client_company,
      clientTitle: input.client_title,
      clientPhone: input.client_phone,
      description: input.description,
      reference: input.reference,
      externalId: input.external_id,
      data: input.data,
      ...(typeof input.send === "boolean" ? { send: input.send } : {}),
      source: "api",
    },
    meta,
  );
  if (result.created) {
    return apiJson({ file: apiFile(result.file), created: true, agreement: apiAgreementOutcome(result.agreement) }, 201);
  }
  // The file already existed (same external_id). Nothing was sent now, but the caller
  // still needs the agreement that is out and its link to carry on.
  const detail = await getFile(actor, result.file.id);
  const reason = result.agreement.reason ?? "A file with this external_id already exists, so it was returned and nothing new was sent.";
  return apiJson({ file: apiFile(detail.file), created: false, agreement: currentAgreementOutcome(detail, reason) }, 200);
}

/**
 * POST /api/v1/files: creates a file and, unless `send` is false or automatic sending is
 * off in the company's settings, sends the agreement.
 */
export const POST = apiRoute(create, {
  // A repeated Idempotency-Key must not create a second file. With an external_id the
  // service already returns the first file, so running again is safe. Without one there
  // is nothing to find the first file by, and saying so is better than a duplicate.
  replay: async (ctx) => {
    const input = ctx.body(CreateFileBody);
    if (typeof input.external_id === "string" && input.external_id.trim() !== "") return create(ctx);
    throw new ApiError(
      "idempotency_key_reused",
      "A request with this Idempotency-Key was already received, so no second file was created. Its result cannot be replayed without an external_id: look the file up with GET /api/v1/files?q=<client email>, and send external_id in future so a repeat returns the same file.",
    );
  },
});
