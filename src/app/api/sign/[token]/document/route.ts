import { pdfResponse } from "@/lib/route";
import { requestMetaFrom } from "@/lib/request";
import { getSigningDocument } from "@/lib/services/signing";
import { failureForDocument, sealed, type SignRouteContext } from "../../shared";

/**
 * The agreement as this signer may see it: prefilled values and earlier signatures
 * drawn in, their own fields still empty. The signing page renders it, and the same
 * address with `?download=1` saves it so it can be read or printed before signing.
 */
export async function GET(request: Request, context: SignRouteContext): Promise<Response> {
  const { token } = await context.params;
  try {
    const document = await getSigningDocument(token, requestMetaFrom(request));
    const download = new URL(request.url).searchParams.get("download") === "1";
    return sealed(pdfResponse(document.bytes, document.filename, { inline: !download }));
  } catch (err) {
    return failureForDocument(request, token, err);
  }
}
