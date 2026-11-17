import { pdfResponse, withActor } from "@/lib/route";
import { getTemplatePdf } from "@/lib/services/templates";

/** The unsigned agreement PDF, for the signed-in company only. The service filters by the caller's company. */
export const GET = withActor<{ id: string }>(async ({ actor, params, request }) => {
  const pdf = await getTemplatePdf(actor, params.id);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return pdfResponse(pdf.bytes, pdf.filename, { inline: !download });
});
