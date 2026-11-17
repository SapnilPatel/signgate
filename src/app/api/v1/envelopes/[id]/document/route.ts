import { apiPdf, apiRoute } from "@/lib/api/http";
import { DocumentQuery } from "@/lib/api/schemas";
import { getDocument } from "@/lib/services/envelopes";

export const maxDuration = 60;

/**
 * GET /api/v1/envelopes/{id}/document?kind=signed|original: the PDF itself. "signed" is
 * the sealed copy with its audit certificate and exists once everyone has signed;
 * before that the answer is 409 not_ready.
 */
export const GET = apiRoute<{ id: string }>(async ({ actor, params, query }) => {
  const { kind } = query(DocumentQuery);
  const document = await getDocument(actor, params.id, kind ?? "signed");
  return apiPdf(document.bytes, document.filename, document.sha256);
});
