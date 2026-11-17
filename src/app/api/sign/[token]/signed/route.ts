import { pdfResponse } from "@/lib/route";
import { requestMetaFrom } from "@/lib/request";
import { getSignedCopy } from "@/lib/services/signing";
import { failureForDocument, sealed, type SignRouteContext } from "../../shared";

/** The sealed, fully signed agreement, for anyone who signed it, from their own link. */
export async function GET(request: Request, context: SignRouteContext): Promise<Response> {
  const { token } = await context.params;
  try {
    const document = await getSignedCopy(token, requestMetaFrom(request));
    const inline = new URL(request.url).searchParams.get("view") === "1";
    return sealed(pdfResponse(document.bytes, document.filename, { inline }));
  } catch (err) {
    return failureForDocument(request, token, err);
  }
}
