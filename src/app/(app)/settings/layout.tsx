import type { Metadata } from "next";
import type { ReactNode } from "react";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { listMembers } from "@/lib/services/accounts";
import { ButtonLink, PageHeader, Sheet } from "@/components/ui";
import { SettingsNav } from "./settings-nav";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { viewer, actor } = await requireActor();

  if (!canManage(viewer.user)) {
    const managers = (await listMembers(actor)).filter((m) => !m.disabled && (m.role === "owner" || m.role === "admin"));
    return (
      <>
        <PageHeader title="Settings" />
        <Sheet className="max-w-2xl p-6">
          <h2 className="text-base font-semibold">Only owners and admins can change company settings</h2>
          <p className="mt-2 text-ink-soft">
            Company details, branding, how agreements are sent, the team and developer access for {viewer.org.name} are managed by its
            owners and admins. If something here needs changing, ask one of them:
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {managers.map((m) => (
              <li key={m.id}>
                <span className="font-semibold">{m.name}</span> <span className="text-ink-soft">({m.role})</span>{" "}
                <a href={`mailto:${m.email}`} className="break-all text-ink-soft underline hover:text-ink">
                  {m.email}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-ink-soft">Your own name, password and saved signature are under your account.</p>
          <div className="mt-5">
            <ButtonLink href="/account" variant="secondary">
              Go to your account
            </ButtonLink>
          </div>
        </Sheet>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description={`How ${viewer.org.name} sends and signs agreements, and who can do it.`} />
      <div className="grid gap-6 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
        <SettingsNav />
        <div className="min-w-0 max-w-2xl space-y-6">{children}</div>
      </div>
    </>
  );
}
