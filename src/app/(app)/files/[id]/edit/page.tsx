import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/request";
import { ServiceError } from "@/lib/services/context";
import { getFile } from "@/lib/services/files";
import { PageHeader } from "@/components/ui";
import { EditFileForm } from "./edit-file-form";

export const metadata: Metadata = { title: "Edit file details" };

export default async function EditFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireActor();
  let detail;
  try {
    detail = await getFile(actor, id);
  } catch (err) {
    if (err instanceof ServiceError && (err.code === "not_found" || err.code === "invalid")) notFound();
    throw err;
  }
  const { file } = detail;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Edit file details"
        description={`File ${file.reference}. Changes here do not alter an agreement that has already been signed.`}
        back={{ href: `/files/${file.id}`, label: file.clientName }}
      />
      <EditFileForm
        file={{
          id: file.id,
          clientName: file.clientName,
          clientEmail: file.clientEmail,
          clientCompany: file.clientCompany ?? "",
          clientTitle: file.clientTitle ?? "",
          clientPhone: file.clientPhone ?? "",
          description: file.description ?? "",
          reference: file.reference,
        }}
      />
    </div>
  );
}
