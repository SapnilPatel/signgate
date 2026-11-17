"use client";

import { readableName } from "../naming";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { PdfOpenError } from "@/components/pdf/pdfjs";
import { rasterizePdf } from "@/components/pdf/rasterize";
import { Button, FormField, Input, Notice, Sheet, Textarea, cx } from "@/components/ui";
import { ApiError, apiJson, beginUpload, cancelUpload, formatBytes, isAbort, sendChunks, uploadIsGone, type UploadSession } from "../upload-client";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; sent: number; total: number }
  | { kind: "converting"; done: number; total: number }
  | { kind: "reading" }
  | { kind: "opening" }
  | { kind: "failed"; message: string };

/** Why a PDF was turned into page images, when it was. */
type Converted = "locked" | "damaged";

/** One attempt to add an agreement. Kept in a ref so "Try again" resumes it instead of starting over. */
interface Job {
  /** Shown while working. */
  title: string;
  name: string;
  /** Pasted wording short enough to send in one request; no upload needed. */
  text?: string;
  blob?: Blob;
  filename?: string;
  mimeType?: string;
  session: UploadSession | null;
  /** Present when `blob` is page pictures joined together rather than the document itself. */
  pageImages?: { size: number; widthPt: number; heightPt: number }[];
  /** The file as chosen, kept so a locked PDF can be converted in the browser. */
  original?: File;
  converted?: Converted;
}

/** Longest pasted text sent in a single request; anything longer goes up in parts like a file. */
const INLINE_TEXT_MAX = 1_000_000;

const ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,text/plain";

const CONVERTED_MESSAGE: Record<Converted, string> = {
  locked: "This PDF is locked against editing, so we converted its pages to images. You will place the fields by hand.",
  damaged: "This PDF has damage we could not repair, so we converted its pages to images. You will place the fields by hand.",
};

async function looksLikePdf(file: File): Promise<boolean> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === "%PDF-";
}

/** A failure the person cannot fix by trying the same thing again. */
class FinalError extends Error {}

export function AddAgreement({ maxBytes, maxPages }: { maxBytes: number; maxPages: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<"file" | "text">("file");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [converted, setConverted] = useState<Converted | null>(null);
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [textError, setTextError] = useState<string | null>(null);

  const jobRef = useRef<Job | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const ids = useId();
  const busy = phase.kind !== "idle" && phase.kind !== "failed";

  // A file dropped beside the drop zone would otherwise replace this page with the file.
  useEffect(() => {
    const stop = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // Closing the tab mid-upload loses the upload; say so before it happens.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  async function run(job: Job) {
    jobRef.current = job;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setError(null);
    setTitle(job.title);
    try {
      let current = job;
      for (;;) {
        if (current.blob) {
          if (!current.session) {
            setPhase({ kind: "uploading", sent: 0, total: current.blob.size });
            current.session = await beginUpload(current.blob, current.filename ?? "agreement", current.mimeType ?? "application/octet-stream", signal);
          }
          await sendChunks(current.session, current.blob, {
            signal,
            onProgress: (sent, total) => setPhase({ kind: "uploading", sent, total }),
          });
        }
        setPhase({ kind: "reading" });
        try {
          const body =
            current.text !== undefined
              ? { text: current.text, name: current.name }
              : { uploadId: current.session?.uploadId, name: current.name, ...(current.pageImages ? { pageImages: current.pageImages } : {}) };
          const created = await apiJson<{ id: string }>("/api/app/templates", { method: "POST", body, signal });
          setPhase({ kind: "opening" });
          jobRef.current = null;
          router.push(`/agreements/${created.id}?added=${current.converted ?? "1"}`);
          return;
        } catch (err) {
          const canConvert =
            err instanceof ApiError && err.fields?.fallback === "page_images" && !current.pageImages && current.original && (await looksLikePdf(current.original));
          if (!canConvert) throw err;
          current = await convertToPageImages(current, err.code === "document_password_protected" ? "locked" : "damaged", err.message, signal);
          jobRef.current = current;
        }
      }
    } catch (err) {
      if (isAbort(err)) return;
      const active = jobRef.current;
      if (uploadIsGone(err) && active) active.session = null;
      const message = err instanceof Error && (err instanceof ApiError || err instanceof FinalError) ? err.message : "Something went wrong while adding the agreement. Try again.";
      if (err instanceof ApiError && (err.transient || uploadIsGone(err))) {
        setPhase({ kind: "failed", message });
      } else {
        // Nothing to resume: clear what was uploaded and let them choose again with the reason in view.
        if (active?.session) void cancelUpload(active.session.uploadId);
        jobRef.current = null;
        setPhase({ kind: "idle" });
        setError(message);
        if (mode === "text" && active?.text !== undefined) setTextError(message);
      }
      requestAnimationFrame(() => statusRef.current?.focus());
    }
  }

  /** The server cannot open this PDF but a browser can show it: draw each page here and send the pictures instead. */
  async function convertToPageImages(job: Job, reason: Converted, serverMessage: string, signal: AbortSignal): Promise<Job> {
    if (job.session) void cancelUpload(job.session.uploadId);
    const original = job.original as File;
    setConverted(reason);
    setPhase({ kind: "converting", done: 0, total: 0 });
    let images;
    try {
      images = await rasterizePdf(new Uint8Array(await original.arrayBuffer()), (done, total) => {
        // rasterizePdf has no cancel of its own; stopping here ends it at the next page.
        if (signal.aborted) throw new DOMException("The upload was cancelled.", "AbortError");
        setPhase({ kind: "converting", done, total });
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      setConverted(null);
      if (err instanceof PdfOpenError && err.reason === "password") {
        throw new FinalError(
          "This PDF needs a password just to open it, so we cannot read it. Open it with the password, print it to a new PDF that has no password, and upload that copy.",
        );
      }
      // The browser could not draw it either; the server's explanation is the useful one.
      throw new FinalError(err instanceof PdfOpenError ? serverMessage : err instanceof Error && err.message ? err.message : serverMessage);
    }
    const bundle = new Blob(images.map((image) => image.bytes as BlobPart));
    if (bundle.size > maxBytes) {
      setConverted(null);
      throw new FinalError(
        `This PDF is locked against editing, and as page images it comes to ${formatBytes(bundle.size)}, over the ${formatBytes(maxBytes)} limit. Print it to a new PDF (which removes the lock) and upload that copy.`,
      );
    }
    const base = original.name.replace(/\.[a-z0-9]{1,6}$/i, "");
    return {
      title: job.title,
      // Page pictures carry no title of their own, so the file's name stands in.
      name: job.name || base,
      blob: bundle,
      filename: `${base || "agreement"}-pages.bin`,
      mimeType: "application/octet-stream",
      session: null,
      pageImages: images.map((image) => ({ size: image.bytes.byteLength, widthPt: image.widthPt, heightPt: image.heightPt })),
      converted: reason,
    };
  }

  function startFile(file: File) {
    if (busy) return;
    setConverted(null);
    if (file.size > maxBytes) {
      setError(`"${file.name}" is ${formatBytes(file.size)}, which is over the ${formatBytes(maxBytes)} limit. Save a smaller copy (for example with "Reduce file size") and upload that.`);
      return;
    }
    void run({ title: file.name, name: readableName(file.name), blob: file, filename: file.name, mimeType: file.type || "application/octet-stream", session: null, original: file });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > 1) {
      setError("Add one agreement at a time. Drop a single file.");
      return;
    }
    startFile(files[0]);
  }

  function submitText(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setConverted(null);
    if (text.trim() === "") {
      setTextError("Paste the wording of your agreement first.");
      return;
    }
    setTextError(null);
    const label = name.trim() || "Pasted agreement";
    if (text.length <= INLINE_TEXT_MAX) {
      void run({ title: label, name: name.trim(), text, session: null });
    } else {
      const blob = new Blob([text], { type: "text/plain" });
      void run({ title: label, name: name.trim(), blob, filename: `${name.trim() || "Agreement"}.txt`, mimeType: "text/plain", session: null });
    }
  }

  function cancel() {
    abortRef.current?.abort();
    const session = jobRef.current?.session;
    if (session) void cancelUpload(session.uploadId);
    jobRef.current = null;
    setConverted(null);
    setPhase({ kind: "idle" });
  }

  const percent = phase.kind === "uploading" && phase.total > 0 ? Math.round((phase.sent / phase.total) * 100) : phase.kind === "converting" && phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : null;

  return (
    <div className="max-w-2xl">
      <Sheet className="p-5 sm:p-8">
        {phase.kind === "idle" ? (
          <>
            <div role="group" aria-label="How to add your agreement" className="mb-6 inline-flex rounded-md border border-rule p-0.5">
              {(
                [
                  ["file", "Upload a file"],
                  ["text", "Paste the text"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  className={cx("rounded-sm px-3 py-1.5 text-sm font-semibold", mode === value ? "bg-ink text-white" : "text-ink-soft hover:text-ink")}
                >
                  {label}
                </button>
              ))}
            </div>

            <div ref={statusRef} tabIndex={-1} className="outline-none">
              {error && mode === "file" ? (
                <Notice tone="error" title="That file could not be used" className="mb-5">
                  {error}
                </Notice>
              ) : null}
            </div>

            {mode === "file" ? (
              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                }}
                onDrop={onDrop}
                className={cx(
                  "rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
                  dragging ? "border-note bg-note-soft" : "border-rule bg-desk/40",
                )}
              >
                <p className="font-serif text-xl font-semibold text-ink">{dragging ? "Drop it here" : "Drop your agreement here"}</p>
                <p className="mt-1 text-ink-soft">or</p>
                <Button size="lg" className="mt-3" onClick={() => fileInput.current?.click()}>
                  Choose a file
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Agreement file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) startFile(file);
                  }}
                />
                <p className="mx-auto mt-5 max-w-[44ch] text-[13px] text-ink-soft">
                  PDF, Word (.docx), PNG, JPEG or plain text. Up to {formatBytes(maxBytes)} and {maxPages} pages. A photo or scan of a signed-by-hand form works
                  too.
                </p>
              </div>
            ) : (
              <form onSubmit={submitText} className="space-y-4" noValidate>
                <FormField label="Name of this agreement" htmlFor={`${ids}-name`} optional hint="Your clients see this name in the email asking them to sign.">
                  <Input id={`${ids}-name`} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoComplete="off" />
                </FormField>
                <FormField
                  label="Agreement text"
                  htmlFor={`${ids}-text`}
                  error={textError}
                  hint="Paste the full wording. Leave blank lines like “Signature: ______” where people sign; if there are none, we add a signature page at the end."
                >
                  <Textarea
                    id={`${ids}-text`}
                    value={text}
                    rows={14}
                    aria-invalid={textError ? true : undefined}
                    onChange={(event) => {
                      setText(event.target.value);
                      if (textError) setTextError(null);
                    }}
                    className="font-serif"
                  />
                </FormField>
                <Button type="submit">Create agreement</Button>
              </form>
            )}
          </>
        ) : (
          <div ref={statusRef} tabIndex={-1} className="outline-none">
            <p className="truncate font-semibold text-ink" title={title}>
              {title}
            </p>

            {converted ? (
              <Notice tone="info" className="mt-4">
                {CONVERTED_MESSAGE[converted]}
              </Notice>
            ) : null}

            {phase.kind === "failed" ? (
              <>
                <Notice tone="error" title="The upload stopped" className="mt-4">
                  {phase.message}
                </Notice>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      const job = jobRef.current;
                      if (job) void run(job);
                    }}
                  >
                    {jobRef.current?.session && jobRef.current.session.done > 0 ? "Try again from where it stopped" : "Try again"}
                  </Button>
                  <Button variant="secondary" onClick={cancel}>
                    Choose a different file
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div
                  className="mt-4 h-2 overflow-hidden rounded-full bg-rule-soft"
                  role="progressbar"
                  aria-label={phase.kind === "converting" ? "Converting pages" : phase.kind === "uploading" ? "Uploading" : "Reading the agreement"}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                >
                  <div
                    className={cx("h-full rounded-full bg-ink transition-[width] duration-200", percent === null && "w-1/3 animate-pulse")}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </div>
                <p className="mt-3 text-sm text-ink-soft" role="status" aria-live="polite">
                  {phase.kind === "uploading"
                    ? `Uploading: ${formatBytes(phase.sent)} of ${formatBytes(phase.total)} (${percent ?? 0}%)`
                    : phase.kind === "converting"
                      ? phase.total > 0
                        ? `Converting page ${Math.min(phase.done + 1, phase.total)} of ${phase.total}`
                        : "Opening the PDF to convert its pages"
                      : phase.kind === "reading"
                        ? "Reading the agreement and finding where people sign. This usually takes a few seconds; a long document can take up to a minute."
                        : "Opening the agreement for you to check"}
                </p>
                {phase.kind === "uploading" || phase.kind === "converting" ? (
                  <Button variant="secondary" size="sm" className="mt-5" onClick={cancel}>
                    Cancel
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )}
      </Sheet>

      <p className="mt-5 max-w-[62ch] text-sm text-ink-soft">
        Next, you will see your document with a box on every place someone signs or fills something in. Check the boxes, then choose “Use this agreement”. Nothing is
        sent to a client until you do.
      </p>
    </div>
  );
}
