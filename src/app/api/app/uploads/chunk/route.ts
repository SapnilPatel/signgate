import { jsonError, withActor } from "@/lib/route";
import { putChunk } from "@/lib/services/uploads";
import { LIMITS } from "@/lib/types";

/**
 * Store one part of an upload. The body is the raw bytes of the part; which upload
 * and which part travel in a header and the query string, so nothing has to be
 * parsed out of the body. Sending the same part again replaces it, which is what
 * makes a retry after a dropped connection safe.
 */
export const PUT = withActor(
  async ({ actor, request }) => {
    // Refuse an oversized body before reading it into memory; the service checks the exact size afterwards.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > LIMITS.uploadChunkBytes) {
      return jsonError("invalid", "That part of the file is larger than expected. Start the upload again.", 413);
    }
    const index = new URL(request.url).searchParams.get("index");
    const bytes = await request.arrayBuffer();
    return putChunk(actor, request.headers.get("x-upload-id"), index, bytes);
  },
  { manage: true },
);
