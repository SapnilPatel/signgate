import { jsonOk, readJson } from "@/lib/route";
import { requestMetaFrom } from "@/lib/request";
import { submitSigning } from "@/lib/services/signing";
import { failure, sealed, type SignRouteContext } from "../../shared";

// Sealing the final copy happens in this request when this is the last signature.
export const maxDuration = 60;

/**
 * Sign. The service validates every value against this signer's own fields and is
 * idempotent, so the page can safely send the same request again after a dropped
 * connection: a repeat returns the first result and writes nothing.
 */
export async function POST(request: Request, context: SignRouteContext): Promise<Response> {
  const { token } = await context.params;
  try {
    const body = await readJson(request);
    const result = await submitSigning(
      token,
      { values: body.values, consent: body.consent, timezone: body.timezone, signedDateLabel: body.signedDateLabel },
      requestMetaFrom(request),
    );
    return sealed(jsonOk(result));
  } catch (err) {
    return failure(err);
  }
}
