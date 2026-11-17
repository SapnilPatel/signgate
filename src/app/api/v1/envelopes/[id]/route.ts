import { apiJson, apiRoute } from "@/lib/api/http";
import { EmptyQuery } from "@/lib/api/schemas";
import { apiEnvelope } from "@/lib/api/shapes";
import { getEnvelope } from "@/lib/services/envelopes";

/** GET /api/v1/envelopes/{id}: one signing request with its signers and where each one stands. */
export const GET = apiRoute<{ id: string }>(async ({ actor, params, query }) => {
  query(EmptyQuery);
  const detail = await getEnvelope(actor, params.id);
  return apiJson({ envelope: apiEnvelope(detail.envelope, detail.signers) });
});
