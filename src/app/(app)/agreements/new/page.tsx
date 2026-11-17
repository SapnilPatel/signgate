import type { Metadata } from "next";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { LIMITS } from "@/lib/types";
import { ButtonLink, Notice, PageHeader } from "@/components/ui";
import { AddAgreement } from "./add-agreement";

export const metadata: Metadata = { title: "Add an agreement" };

export default async function NewAgreementPage() {
  const { viewer } = await requireActor();
  const back = { href: "/agreements", label: "Agreements" };

  if (!canManage(viewer.user)) {
    return (
      <>
        <PageHeader title="Add an agreement" back={back} />
        <Notice tone="info" title="Only an owner or admin can add an agreement">
          <p>The agreement is what every client signs, so changes to it are limited to owners and admins. Ask one of them to add it.</p>
          <ButtonLink href="/agreements" variant="secondary" size="sm" className="mt-3">
            Back to agreements
          </ButtonLink>
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add an agreement"
        back={back}
        description="Upload the agreement your clients sign, exactly as you use it today. We find where people sign and fill things in, and you check the result before anything is sent."
      />
      <AddAgreement maxBytes={LIMITS.maxUploadBytes} maxPages={LIMITS.maxPages} />
    </>
  );
}
