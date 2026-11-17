import { jsonOk, readJson } from "@/lib/route";
import { requestMetaFrom } from "@/lib/request";
import { declineSigning } from "@/lib/services/signing";
import { failure, sealed, type SignRouteContext } from "../../shared";

/** Decline to sign, with an optional reason for the sender. Repeating it changes nothing. */
export async function POST(request: Request, context: SignRouteContext): Promise<Response> {
  const { token } = await context.params;
  try {
    const body = await readJson(request);
    return sealed(jsonOk(await declineSigning(token, body.reason, requestMetaFrom(request))));
  } catch (err) {
    return failure(err);
  }
}
