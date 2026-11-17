import type { Metadata } from "next";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { resolveSettings } from "@/lib/services/accounts";
import { ServiceError } from "@/lib/services/context";
import { getTemplate } from "@/lib/services/templates";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { agreementView } from "../view";
import { ReviewAgreement } from "./review";

export const metadata: Metadata = { title: "Review agreement" };

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

export default async function AgreementPage({ params, searchParams }: PageProps<"/agreements/[id]">) {
  const { viewer, actor } = await requireActor();
  const { id } = await params;
  const added = first((await searchParams).added);

  let template;
  try {
    template = await getTemplate(actor, id);
  } catch (err) {
    if (!(err instanceof ServiceError) || err.code !== "not_found") throw err;
    return (
      <>
        <PageHeader title="Agreement not found" back={{ href: "/agreements", label: "Agreements" }} />
        <EmptyState title="This agreement is not here" action={<ButtonLink href="/agreements">See your agreements</ButtonLink>}>
          <p>It may have been removed, or the link may be wrong. Your list of agreements shows everything your company has.</p>
        </EmptyState>
      </>
    );
  }

  const settings = resolveSettings(viewer.org);
  return (
    <ReviewAgreement
      initial={await agreementView(actor, template)}
      canEdit={canManage(viewer.user)}
      added={added === "locked" || added === "damaged" || added === "1" ? added : null}
      autoSend={settings.autoSendOnFileCreate}
      timeZone={settings.timeZone ?? "UTC"}
    />
  );
}
