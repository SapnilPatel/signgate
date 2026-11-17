import { apiJson, apiRoute } from "@/lib/api/http";
import { VoidBody } from "@/lib/api/schemas";
import { apiEnvelope } from "@/lib/api/shapes";
import { getEnvelope, voidEnvelope } from "@/lib/services/envelopes";

/**
 * POST /api/v1/envelopes/{id}/void: cancels a signing request; its links stop working at
 * once. Voiding a voided envelope changes nothing, so a repeated Idempotency-Key runs again.
 */
export const POST = apiRoute<{ id: string }>(
  async ({ actor, params, body, meta }) => {
    const input = body(VoidBody);
    const result = await voidEnvelope(actor, params.id, input.reason ?? "", meta, { includeSigned: input.include_signed === true });
    const detail = await getEnvelope(actor, params.id);
    return apiJson({ envelope: apiEnvelope(detail.envelope, detail.signers), already_voided: result.alreadyVoided });
  },
  { replay: "rerun" },
);
