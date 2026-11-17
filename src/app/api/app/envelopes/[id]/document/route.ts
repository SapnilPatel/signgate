import { jsonError, pdfResponse, withActor } from "@/lib/route";
import { getDocument } from "@/lib/services/envelopes";

const KINDS = ["original", "in_progress", "signed"] as const;
type Kind = (typeof KINDS)[number];

/**
 * An agreement's PDF for the signed-in company: `?kind=original` (exactly as sent),
 * `in_progress` (with the signatures given so far) or `signed` (the sealed final copy).
 * Opens in the browser's viewer unless `download=1`. The service scopes the lookup to
 * the caller's company and names the file after the file reference and client.
 */
export const GET = withActor<{ id: string }>(async ({ actor, params, request }) => {
  const query = new URL(request.url).searchParams;
  const kind = query.get("kind") ?? "original";
  if (!(KINDS as readonly string[]).includes(kind)) {
    return jsonError("invalid", "That document type is not known. Go back to the file and use one of its download links.", 422);
  }
  const document = await getDocument(actor, params.id, kind as Kind);
  return pdfResponse(document.bytes, document.filename, { inline: query.get("download") !== "1" });
});
