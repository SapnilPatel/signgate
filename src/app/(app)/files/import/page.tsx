import type { Metadata } from "next";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { FILE_LIMITS } from "@/lib/services/files";
import { PageHeader } from "@/components/ui";
import { getSendingOutlook } from "../outlook";
import { ImportFlow } from "./import-flow";

export const metadata: Metadata = { title: "Import files" };

export default async function ImportPage() {
  const { viewer, actor } = await requireActor();
  const outlook = await getSendingOutlook(actor, viewer.org);
  return (
    <>
      <PageHeader
        title="Import files from a spreadsheet"
        description="Create a file for every client in a list. You see exactly what will be created, and any rows with problems, before anything is saved or sent."
        back={{ href: "/files", label: "Files" }}
      />
      <ImportFlow outlook={outlook} manager={canManage(viewer.user)} maxRows={FILE_LIMITS.importMaxRows} />
    </>
  );
}
