import { readJson, withActor } from "@/lib/route";
import { beginUpload, discardUpload } from "@/lib/services/uploads";

/** Header that carries the signed upload id on every request after the first. */
const UPLOAD_ID_HEADER = "x-upload-id";

/** Start a chunked upload: announces the file and returns the id the parts are sent under. */
export const POST = withActor(
  async ({ actor, request }) => {
    const body = await readJson(request);
    return beginUpload(actor, { filename: body.filename, size: body.size, mimeType: body.mimeType });
  },
  { manage: true },
);

/** Cancel an upload and remove the parts that already arrived. Safe to call twice. */
export const DELETE = withActor(
  async ({ actor, request }) => {
    const removed = await discardUpload(actor, request.headers.get(UPLOAD_ID_HEADER));
    return { removed };
  },
  { manage: true },
);
