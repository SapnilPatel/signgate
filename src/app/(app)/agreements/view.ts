import "server-only";
import type { Template } from "@/lib/db/schema";
import type { Actor } from "@/lib/services/context";
import { getTemplateReadiness, intakeUrl, type Readiness } from "@/lib/services/templates";
import type { DetectionMeta, Field, PageInfo } from "@/lib/types";

/**
 * Everything the review screen needs about one agreement, as plain data that can
 * cross from the server to the browser. The screen keeps its own copy and replaces
 * it with whatever a save or an action returns, so it never depends on a re-render.
 */
export interface AgreementView {
  id: string;
  name: string;
  status: Template["status"];
  isDefault: boolean;
  version: number;
  pages: PageInfo[];
  fields: Field[];
  detection: DetectionMeta | null;
  /** The public client intake link, or null when it is off. */
  intakeUrl: string | null;
  updatedAt: string;
  readiness: Readiness;
}

export async function agreementView(actor: Actor, template: Template): Promise<AgreementView> {
  return {
    id: template.id,
    name: template.name,
    status: template.status,
    isDefault: template.isDefault,
    version: template.version,
    pages: Array.isArray(template.pages) ? template.pages : [],
    fields: Array.isArray(template.fields) ? template.fields : [],
    detection: template.detection ?? null,
    intakeUrl: template.intakeToken ? intakeUrl(template.intakeToken) : null,
    updatedAt: template.updatedAt.toISOString(),
    readiness: await getTemplateReadiness(actor, template.id),
  };
}
