/**
 * Browser side of the chunked upload: the file goes up in parts small enough for
 * the host's request-size cap, each part is retried on its own, and an upload that
 * failed part-way can be picked up where it stopped.
 */

/** A failure from one of our own endpoints, or from the network on the way there. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the request never got an answer: offline, dropped connection, timeout. */
  get network(): boolean {
    return this.status === 0;
  }

  /** True when sending the very same request again may work. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

const OFFLINE = "The connection dropped before this finished. Check your internet connection, then try again.";

function errorFromBody(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown; fields?: unknown } } | null)?.error;
  if (error && typeof error.message === "string") {
    return new ApiError(
      typeof error.code === "string" ? error.code : "error",
      error.message,
      status,
      error.fields && typeof error.fields === "object" ? (error.fields as Record<string, string>) : undefined,
    );
  }
  if (status === 413) return new ApiError("too_large", "That was too large to send in one piece. Start the upload again.", status);
  if (status === 401) return new ApiError("unauthenticated", "You are signed out. Sign in again in another tab, then try again.", status);
  return new ApiError("error", "Something went wrong on our side. Try again; if it keeps happening, contact support.", status);
}

/** JSON request to one of the signed-in endpoints. Throws ApiError with the server's own message. */
export async function apiJson<T>(url: string, init: { method: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      credentials: "same-origin",
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    throw new ApiError("network", OFFLINE, 0);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A proxy or the platform answered with something that is not ours (for example a 413 page).
  }
  if (!response.ok) throw errorFromBody(response.status, body);
  return body as T;
}

export interface UploadSession {
  uploadId: string;
  chunkCount: number;
  chunkSize: number;
  /** Parts already stored. An interrupted upload resumes from here. */
  done: number;
  size: number;
}

export async function beginUpload(blob: Blob, filename: string, mimeType: string, signal?: AbortSignal): Promise<UploadSession> {
  const started = await apiJson<{ uploadId: string; chunkCount: number; chunkSize: number }>("/api/app/uploads", {
    method: "POST",
    body: { filename, size: blob.size, mimeType },
    signal,
  });
  return { ...started, done: 0, size: blob.size };
}

/** One part, sent with XMLHttpRequest because fetch cannot report how much of a body has gone out. */
function putChunk(session: UploadSession, index: number, part: Blob, onSent: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (fn: () => void) => {
      signal?.removeEventListener("abort", abort);
      fn();
    };
    xhr.open("PUT", `/api/app/uploads/chunk?index=${index}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Upload-Id", session.uploadId);
    xhr.responseType = "text";
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (event) => onSent(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return finish(resolve);
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not our JSON; errorFromBody falls back on the status.
      }
      finish(() => reject(errorFromBody(xhr.status, body)));
    };
    xhr.onerror = () => finish(() => reject(new ApiError("network", OFFLINE, 0)));
    xhr.ontimeout = () => finish(() => reject(new ApiError("network", OFFLINE, 0)));
    xhr.onabort = () => finish(() => reject(new DOMException("The upload was cancelled.", "AbortError")));
    if (signal?.aborted) return reject(new DOMException("The upload was cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort);
    xhr.send(part);
  });
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The upload was cancelled.", "AbortError"));
      },
      { once: true },
    );
  });

/**
 * Send every part that has not arrived yet. A part that fails for a passing reason
 * is tried again twice by itself before the error is handed to the caller; calling
 * this again with the same session then resumes at that part.
 */
export async function sendChunks(
  session: UploadSession,
  blob: Blob,
  opts: { onProgress?: (sentBytes: number, totalBytes: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const report = (inFlight: number) => opts.onProgress?.(Math.min(session.size, session.done * session.chunkSize + inFlight), session.size);
  report(0);
  while (session.done < session.chunkCount) {
    const index = session.done;
    const part = blob.slice(index * session.chunkSize, Math.min(blob.size, (index + 1) * session.chunkSize));
    for (let attempt = 0; ; attempt++) {
      try {
        await putChunk(session, index, part, report, opts.signal);
        break;
      } catch (err) {
        if (!(err instanceof ApiError) || !err.transient || attempt >= 2) throw err;
        report(0);
        await wait(800 * (attempt + 1), opts.signal);
      }
    }
    session.done = index + 1;
    report(0);
  }
}

/** Tell the server to drop the parts of an upload nobody will finish. Best effort: stale parts are purged anyway. */
export async function cancelUpload(uploadId: string): Promise<void> {
  try {
    await apiJson("/api/app/uploads", { method: "DELETE", headers: { "X-Upload-Id": uploadId } });
  } catch {
    // Nothing for the person to do about it.
  }
}

/** True when the server no longer knows the upload, so resuming is pointless and it must start over. */
export function uploadIsGone(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 410);
}

export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}
