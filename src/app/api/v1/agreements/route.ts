import { apiJson, apiRoute } from "@/lib/api/http";
import { ListAgreementsQuery } from "@/lib/api/schemas";
import { apiAgreement } from "@/lib/api/shapes";
import { listTemplates } from "@/lib/services/templates";

/** GET /api/v1/agreements: the company's agreements, so an integration can choose which one to send. */
export const GET = apiRoute(async ({ actor, query }) => {
  const { include_archived } = query(ListAgreementsQuery);
  const all = await listTemplates(actor);
  const shown = include_archived === "true" ? all : all.filter((a) => a.status !== "archived");
  return apiJson({ agreements: shown.map(apiAgreement) });
});
