import { apiJson, apiRoute } from "@/lib/api/http";
import { SendBody } from "@/lib/api/schemas";
import { apiAgreementOutcome, apiFile, currentAgreementOutcome } from "@/lib/api/shapes";
import { sendAgreementForFile } from "@/lib/services/envelopes";
import { getFile } from "@/lib/services/files";

// Sending renders the agreement with the file's details before it goes out.
export const maxDuration = 60;

/**
 * POST /api/v1/files/{id}/send: sends the default agreement, or the one named by
 * `agreement_id`, for a file that has none out. `replace: true` voids the one that is
 * out and sends a fresh one.
 */
export const POST = apiRoute<{ id: string }>(
  async ({ actor, params, body, meta }) => {
    const input = body(SendBody);
    const sent = await sendAgreementForFile(
      actor,
      params.id,
      {
        ...(input.agreement_id ? { templateId: input.agreement_id } : {}),
        replace: input.replace === true,
        ...(input.replace_envelope_id ? { replaceEnvelopeId: input.replace_envelope_id } : {}),
        replaceSigned: input.replace_signed === true,
      },
      meta,
    );
    const detail = await getFile(actor, params.id);
    return apiJson({
      file: apiFile(detail.file),
      agreement: apiAgreementOutcome({
        sent: !sent.duplicate,
        envelopeId: sent.envelopeId,
        delivery: sent.delivery,
        ...(sent.deliveryReason ? { deliveryReason: sent.deliveryReason } : {}),
        signingUrl: sent.signingUrl,
        ...(sent.duplicate ? { reason: "This request repeated an earlier one, so the agreement it sent was returned and nothing new went out." } : {}),
      }),
    });
  },
  {
    // A repeated key answers with the agreement the first request put on the file.
    replay: async ({ actor, params, body }) => {
      body(SendBody);
      const detail = await getFile(actor, params.id);
      return apiJson({
        file: apiFile(detail.file),
        agreement: currentAgreementOutcome(detail, "A request with this Idempotency-Key was already carried out, so nothing new was sent. This is the agreement on the file now."),
      });
    },
  },
);
