import { errorResponse, jsonError, jsonOk, readJson, withActor } from "@/lib/route";
import { ServiceError } from "@/lib/services/context";
import {
  DocumentServiceError,
  createTemplateFromCompletedUpload,
  createTemplateFromPageImages,
  createTemplateFromText,
} from "@/lib/services/templates";
import { completeUpload, discardUpload } from "@/lib/services/uploads";

// Reading a long document and finding its fields can take longer than the default allowance.
export const maxDuration = 60;

/**
 * The engine's own reason a document was refused, kept in the error code so the
 * upload page can tell "locked PDF" (which it can work around by sending pictures
 * of the pages) from "not a document we support" (which it cannot).
 */
function documentError(err: DocumentServiceError): Response {
  return jsonError(`document_${err.documentCode}`, err.message, err.status, err.pageImageFallback ? { fallback: "page_images" } : undefined);
}

/**
 * Create a draft agreement. Three bodies are accepted:
 *   { uploadId, name? }               a finished chunked upload of the file itself
 *   { uploadId, pageImages, name? }   a finished chunked upload holding page pictures back to back
 *   { text, name? }                   pasted wording
 */
export const POST = withActor(
  async ({ actor, request, meta }) => {
    const body = await readJson(request);
    try {
      if (typeof body.text === "string") {
        const template = await createTemplateFromText(actor, { text: body.text, name: body.name }, meta);
        return jsonOk({ id: template.id }, 201);
      }

      if (Array.isArray(body.pageImages)) {
        const upload = await completeUpload(actor, body.uploadId);
        // The browser sent every page picture joined into one file; cut it back apart by the sizes it declared.
        const images: { bytes: Uint8Array; widthPt: number; heightPt: number }[] = [];
        let offset = 0;
        for (const item of body.pageImages) {
          const page = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const size = Number(page.size);
          if (!Number.isInteger(size) || size <= 0 || offset + size > upload.bytes.byteLength) {
            throw new ServiceError("invalid", "The converted pages did not arrive intact. Upload the document again.");
          }
          images.push({ bytes: upload.bytes.subarray(offset, offset + size), widthPt: Number(page.widthPt), heightPt: Number(page.heightPt) });
          offset += size;
        }
        if (offset !== upload.bytes.byteLength) {
          throw new ServiceError("invalid", "The converted pages did not arrive intact. Upload the document again.");
        }
        const template = await createTemplateFromPageImages(actor, { images, name: body.name }, meta);
        // The agreement is stored; parts that fail to delete here are purged by the scheduler.
        await discardUpload(actor, body.uploadId).catch(() => 0);
        return jsonOk({ id: template.id }, 201);
      }

      const template = await createTemplateFromCompletedUpload(actor, body.uploadId, { name: body.name }, meta);
      return jsonOk({ id: template.id }, 201);
    } catch (err) {
      if (err instanceof DocumentServiceError) return documentError(err);
      return errorResponse(err);
    }
  },
  { manage: true },
);
