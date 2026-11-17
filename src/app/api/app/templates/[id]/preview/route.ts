import { pdfResponse, withActor } from "@/lib/route";
import { getTemplate, previewTemplatePdf } from "@/lib/services/templates";

// Stamping every field of a long agreement can take longer than the default allowance.
export const maxDuration = 60;

/** The agreement with sample values and signatures in every field, as the client would get it back. */
export const GET = withActor<{ id: string }>(async ({ actor, params }) => {
  const template = await getTemplate(actor, params.id);
  const bytes = await previewTemplatePdf(actor, params.id);
  return pdfResponse(bytes, `${template.name} (preview)`, { inline: true });
});
