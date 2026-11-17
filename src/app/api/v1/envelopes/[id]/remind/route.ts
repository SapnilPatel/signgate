import { apiJson, apiRoute } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { apiEnvelope } from "@/lib/api/shapes";
import { getEnvelope, sendReminderNow } from "@/lib/services/envelopes";

/** POST /api/v1/envelopes/{id}/remind: emails whoever the envelope is waiting on, now. */
export const POST = apiRoute<{ id: string }>(
  async ({ actor, params, body, meta }) => {
    body(EmptyBody);
    const result = await sendReminderNow(actor, params.id, meta);
    const detail = await getEnvelope(actor, params.id);
    return apiJson({
      reminded: true,
      to: result.to,
      delivery: result.delivery,
      delivery_note: result.deliveryReason ?? null,
      signing_url: result.signingUrl,
      envelope: apiEnvelope(detail.envelope, detail.signers),
    });
  },
  {
    // A second email is exactly what a repeated key must not cause.
    replay: async ({ actor, params, body }) => {
      body(EmptyBody);
      const detail = await getEnvelope(actor, params.id);
      return apiJson({ reminded: false, to: null, delivery: null, delivery_note: null, signing_url: null, envelope: apiEnvelope(detail.envelope, detail.signers) });
    },
  },
);
