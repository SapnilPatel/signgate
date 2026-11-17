import { apiJson, apiRoute } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { apiFile } from "@/lib/api/shapes";
import { archiveFile } from "@/lib/services/files";

/**
 * POST /api/v1/files/{id}/archive: takes the file off the working lists and voids any
 * agreement still out for signature. Archiving an archived file changes nothing, which
 * is why a repeated Idempotency-Key simply runs it again.
 */
export const POST = apiRoute<{ id: string }>(
  async ({ actor, params, body, meta }) => {
    body(EmptyBody);
    const result = await archiveFile(actor, params.id, meta);
    return apiJson({ file: apiFile(result.file), voided_envelopes: result.voided });
  },
  { replay: "rerun" },
);
