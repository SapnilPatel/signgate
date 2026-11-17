import { agreementView } from "@/app/(app)/agreements/view";
import { errorResponse, jsonError, readJson, withActor } from "@/lib/route";
import { DocumentServiceError, replaceTemplateDocument } from "@/lib/services/templates";
import { completeUpload, discardUpload } from "@/lib/services/uploads";

export const maxDuration = 60;

/**
 * Replace the document behind an agreement with a finished chunked upload. The
 * uploaded parts are only removed once the new document is stored, so a failure
 * here can be retried without uploading again.
 */
export const POST = withActor<{ id: string }>(
  async ({ actor, params, request, meta }) => {
    const body = await readJson(request);
    try {
      const upload = await completeUpload(actor, body.uploadId);
      const template = await replaceTemplateDocument(
        actor,
        params.id,
        { bytes: upload.bytes, filename: upload.filename, mimeType: upload.mimeType },
        body.version,
        meta,
      );
      await discardUpload(actor, body.uploadId).catch(() => 0);
      return await agreementView(actor, template);
    } catch (err) {
      if (err instanceof DocumentServiceError) return jsonError(`document_${err.documentCode}`, err.message, err.status);
      return errorResponse(err);
    }
  },
  { manage: true },
);
