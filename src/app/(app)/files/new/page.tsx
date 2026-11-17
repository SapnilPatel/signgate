import type { Metadata } from "next";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { PageHeader } from "@/components/ui";
import { getSendingOutlook } from "../outlook";
import { NewFileForm } from "./new-file-form";

export const metadata: Metadata = { title: "New file" };

export default async function NewFilePage() {
  const { viewer, actor } = await requireActor();
  const outlook = await getSendingOutlook(actor, viewer.org);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New file" description="One file for one client job. Saving it sends your agreement to the client for signature." back={{ href: "/files", label: "Files" }} />
      <NewFileForm outlook={outlook} manager={canManage(viewer.user)} />
    </div>
  );
}
