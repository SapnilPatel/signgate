import { apiJson, apiRoute } from "@/lib/api/http";
import { EmptyQuery } from "@/lib/api/schemas";
import { apiAgreement, apiCompany } from "@/lib/api/shapes";
import { listTemplates } from "@/lib/services/templates";

/**
 * GET /api/v1/me: which company this key belongs to. It is the connectivity test, so it
 * also says whether creating a file would send an agreement right now.
 */
export const GET = apiRoute(async ({ actor, org, query }) => {
  query(EmptyQuery);
  const agreements = await listTemplates(actor);
  const standard = agreements.find((a) => a.isDefault && a.status === "active") ?? null;
  return apiJson({
    company: apiCompany(org),
    api_key: { id: actor.keyId },
    default_agreement: standard ? apiAgreement(standard) : null,
  });
});
