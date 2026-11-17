"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Input, Sheet, buttonClass } from "@/components/ui";
import type { ActionState } from "@/lib/action";
import { LIMITS } from "@/lib/types";
import {
  archiveAgreementAction,
  disableIntakeLinkAction,
  duplicateAgreementAction,
  enableIntakeLinkAction,
  makeDefaultAction,
  redetectFieldsAction,
  renameAgreementAction,
} from "../actions";
import { ConfirmDialog } from "../confirm-dialog";
import { ApiError, apiJson, beginUpload, cancelUpload, formatBytes, isAbort, sendChunks } from "../upload-client";
import type { AgreementView } from "../view";
import type { Perform } from "./review";

const ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,text/plain";

type Confirming = { kind: "redetect" } | { kind: "replace"; file: File } | { kind: "archive" } | { kind: "intake-off" } | null;

function Row({ id, title, children, controls }: { id?: string; title: string; children: ReactNode; controls: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-32 flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1 basis-72">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <div className="mt-0.5 max-w-[60ch] text-sm text-ink-soft">{children}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{controls}</div>
    </section>
  );
}

/** Everything about an agreement besides its fields: name, default, document, intake link, copy and archive. */
export function ManageAgreement({
  view,
  dirty,
  busy,
  perform,
  adopt,
  announce,
  reportProblem,
  save,
  onAddedNoticeDone,
}: {
  view: AgreementView;
  dirty: boolean;
  busy: string | null;
  perform: Perform;
  adopt: (next: AgreementView, opts?: { documentChanged?: boolean }) => void;
  announce: (text: string) => void;
  reportProblem: (message: string) => void;
  save: () => Promise<boolean>;
  onAddedNoticeDone: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  // What is being typed in the name box, tied to the stored name it started from: when the
  // stored name changes (a save, a colleague's rename after a reload) the box follows it.
  const [nameDraft, setNameDraft] = useState({ from: view.name, text: view.name });
  const name = nameDraft.from === view.name ? nameDraft.text : view.name;
  const setName = (text: string) => setNameDraft({ from: view.name, text });
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [upload, setUpload] = useState<{ sent: number; total: number } | "reading" | null>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const working = busy !== null;

  useEffect(() => () => abortRef.current?.abort(), []);

  const unsavedWarning = dirty ? <p className="font-semibold text-ink">The changes you have not saved will be lost too.</p> : null;

  function rename() {
    void perform(
      "rename",
      () => renameAgreementAction(view.id, name),
      (next: AgreementView) => {
        adopt(next);
        announce(`The agreement is now called “${next.name}”.`);
      },
    );
  }

  function makeDefault() {
    void perform(
      "default",
      () => makeDefaultAction(view.id),
      (next: AgreementView) => {
        adopt(next);
        announce(`“${next.name}” is now your default agreement: the one sent on new files.`);
      },
    );
  }

  function redetect() {
    setConfirming(null);
    void perform(
      "redetect",
      () => redetectFieldsAction(view.id, view.version),
      (next: AgreementView) => {
        adopt(next, { documentChanged: true });
        onAddedNoticeDone();
        announce(`The fields were detected again. ${next.fields.length === 1 ? "1 field was" : `${next.fields.length} fields were`} found; check them on the document.`);
      },
    );
  }

  function replace(file: File) {
    setConfirming(null);
    const controller = new AbortController();
    abortRef.current = controller;
    void perform(
      "replace",
      async (): Promise<ActionState<AgreementView>> => {
        let uploadId: string | null = null;
        try {
          setUpload({ sent: 0, total: file.size });
          const session = await beginUpload(file, file.name, file.type || "application/octet-stream", controller.signal);
          uploadId = session.uploadId;
          await sendChunks(session, file, { signal: controller.signal, onProgress: (sent, total) => setUpload({ sent, total }) });
          setUpload("reading");
          const next = await apiJson<AgreementView>(`/api/app/templates/${view.id}/document`, {
            method: "POST",
            body: { uploadId, version: view.version },
            signal: controller.signal,
          });
          return { ok: true, data: next };
        } catch (err) {
          if (uploadId) void cancelUpload(uploadId);
          if (isAbort(err)) return { ok: false, error: "The upload was cancelled. The agreement still has its old document." };
          if (err instanceof ApiError) {
            const locked = err.code === "document_password_protected" || err.code === "document_corrupt";
            return {
              ok: false,
              code: err.code,
              error: locked ? `${err.message} To use this PDF anyway, add it as a new agreement: that page can convert a locked PDF into page images.` : err.message,
            };
          }
          return { ok: false, error: "The new document could not be uploaded. Try again." };
        } finally {
          setUpload(null);
        }
      },
      (next: AgreementView) => {
        adopt(next, { documentChanged: true });
        onAddedNoticeDone();
        announce(`The document was replaced. ${next.fields.length === 1 ? "1 field was" : `${next.fields.length} fields were`} found in the new one; check them on the document.`);
      },
    );
  }

  function archive() {
    setConfirming(null);
    void perform(
      "archive",
      () => archiveAgreementAction(view.id),
      (next: AgreementView, message) => {
        adopt(next);
        announce(message ?? `“${next.name}” is archived.`);
      },
    );
  }

  async function duplicate() {
    if (!(await save())) return;
    await perform(
      "duplicate",
      () => duplicateAgreementAction(view.id),
      (copy: { id: string; name: string }) => router.push(`/agreements/${copy.id}`),
    );
  }

  function intake(on: boolean) {
    setConfirming(null);
    setCopied(null);
    void perform(
      "intake",
      () => (on ? enableIntakeLinkAction(view.id) : disableIntakeLinkAction(view.id)),
      (next: AgreementView) => {
        adopt(next);
        announce(on ? "The client intake link is on. Copy it from further down this page." : "The client intake link is off. Anyone opening the old link is told it no longer works.");
      },
    );
  }

  async function copyLink() {
    if (!view.intakeUrl) return;
    try {
      await navigator.clipboard.writeText(view.intakeUrl);
      setCopied("yes");
    } catch {
      // Clipboard access can be refused; leave the link selected so one keystroke copies it.
      linkInput.current?.select();
      setCopied("manual");
    }
  }

  function chooseFile(file: File) {
    if (file.size > LIMITS.maxUploadBytes) {
      reportProblem(`“${file.name}” is ${formatBytes(file.size)}, which is over the ${formatBytes(LIMITS.maxUploadBytes)} limit. Save a smaller copy and choose that.`);
      return;
    }
    setConfirming({ kind: "replace", file });
  }

  const nameChanged = name.trim() !== "" && name.trim() !== view.name;

  return (
    <section aria-labelledby={`${ids}-manage`} className="pt-4">
      <h2 id={`${ids}-manage`} className="mb-2 font-serif text-xl font-semibold text-ink">
        Manage this agreement
      </h2>
      <Sheet className="divide-y divide-rule-soft">
        <Row
          title="Name"
          controls={
            <form
              className="flex w-full flex-wrap gap-2 sm:w-auto"
              onSubmit={(event) => {
                event.preventDefault();
                if (nameChanged && !working) rename();
              }}
            >
              <label htmlFor={`${ids}-name`} className="sr-only">
                Name of this agreement
              </label>
              <Input id={`${ids}-name`} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 sm:w-64" autoComplete="off" />
              <Button type="submit" variant="secondary" disabled={!nameChanged || working} aria-busy={busy === "rename"}>
                {busy === "rename" ? "Saving…" : "Save name"}
              </Button>
            </form>
          }
        >
          Clients see this name in the email asking them to sign.
        </Row>

        <Row
          title="Default agreement"
          controls={
            view.status === "active" && !view.isDefault ? (
              <Button variant="secondary" onClick={makeDefault} disabled={working} aria-busy={busy === "default"}>
                {busy === "default" ? "Changing…" : "Make this the default"}
              </Button>
            ) : null
          }
        >
          {view.isDefault
            ? "This is your default agreement: the one sent on new files."
            : view.status === "active"
              ? "The default agreement is the one sent on new files. Another agreement is the default at the moment."
              : view.status === "archived"
                ? "An archived agreement cannot be the default. Choose “Use this agreement again” first."
                : "The default agreement is the one sent on new files. Choose “Use this agreement” first; if it is your only one, it becomes the default."}
        </Row>

        <Row
          id="manage-document"
          title="Document"
          controls={
            upload ? (
              <div className="w-full sm:w-72">
                <div
                  className="h-2 overflow-hidden rounded-full bg-rule-soft"
                  role="progressbar"
                  aria-label="Uploading the new document"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={upload === "reading" ? undefined : Math.round((upload.sent / Math.max(1, upload.total)) * 100)}
                >
                  <div
                    className={upload === "reading" ? "h-full w-1/3 animate-pulse rounded-full bg-ink" : "h-full rounded-full bg-ink transition-[width]"}
                    style={upload === "reading" ? undefined : { width: `${Math.round((upload.sent / Math.max(1, upload.total)) * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[13px] text-ink-soft" role="status">
                  {upload === "reading" ? "Reading the new document and finding its fields…" : `Uploading: ${formatBytes(upload.sent)} of ${formatBytes(upload.total)}`}
                </p>
                {upload !== "reading" ? (
                  <Button variant="secondary" size="sm" className="mt-2" onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={working}>
                  Replace the document
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="New document for this agreement"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) chooseFile(file);
                  }}
                />
                <Button variant="secondary" onClick={() => setConfirming({ kind: "redetect" })} disabled={working} aria-busy={busy === "redetect"}>
                  {busy === "redetect" ? "Detecting…" : "Detect fields again"}
                </Button>
                <a href={`/api/app/templates/${view.id}/pdf?download=1`} className={buttonClass("quiet")}>
                  Download the PDF
                </a>
              </>
            )
          }
        >
          Upload a corrected version of the wording, or have the fields found again from scratch. Either way, agreements you have already sent keep the document they
          were sent with.
        </Row>

        <Row
          title="Client intake link"
          controls={
            view.intakeUrl ? (
              <div className="w-full sm:w-auto">
                <div className="flex flex-wrap gap-2">
                  <label htmlFor={`${ids}-intake`} className="sr-only">
                    Client intake link
                  </label>
                  <Input
                    ref={linkInput}
                    id={`${ids}-intake`}
                    readOnly
                    value={view.intakeUrl}
                    className="min-w-0 flex-1 font-mono !text-[13px] sm:w-72"
                    onFocus={(event) => event.target.select()}
                  />
                  <Button variant="secondary" onClick={copyLink}>
                    {copied === "yes" ? "Copied" : "Copy link"}
                  </Button>
                  <Button variant="danger" onClick={() => setConfirming({ kind: "intake-off" })} disabled={working}>
                    Turn off
                  </Button>
                </div>
                <p className="mt-1.5 text-[13px] text-ink-soft" role="status">
                  {copied === "yes" ? "The link is on your clipboard." : copied === "manual" ? "The link is selected. Press Ctrl or Command + C to copy it." : ""}
                </p>
              </div>
            ) : view.status === "active" ? (
              <Button variant="secondary" onClick={() => intake(true)} disabled={working} aria-busy={busy === "intake"}>
                {busy === "intake" ? "Turning on…" : "Turn on the intake link"}
              </Button>
            ) : null
          }
        >
          A link for your website or your emails. A new client opens it, enters their own details and signs this agreement, and a file is created for them
          without anyone on your team typing anything.
          {!view.intakeUrl && view.status !== "active" ? " It can be turned on once this agreement is in use." : ""}
        </Row>

        <Row
          title="Copy or archive"
          controls={
            <>
              <Button variant="secondary" onClick={() => void duplicate()} disabled={working} aria-busy={busy === "duplicate"}>
                {busy === "duplicate" ? "Copying…" : dirty ? "Save and duplicate" : "Duplicate"}
              </Button>
              {view.status !== "archived" ? (
                <Button variant="danger" onClick={() => setConfirming({ kind: "archive" })} disabled={working} aria-busy={busy === "archive"}>
                  {busy === "archive" ? "Archiving…" : "Archive"}
                </Button>
              ) : null}
            </>
          }
        >
          Duplicate makes a draft copy to change without touching this one. Archive takes this agreement out of use; agreements already sent from it are not
          affected.
        </Row>
      </Sheet>

      <ConfirmDialog
        open={confirming?.kind === "redetect"}
        title="Detect the fields again?"
        confirmLabel="Detect fields again"
        onConfirm={redetect}
        onCancel={() => setConfirming(null)}
      >
        <p>Every field on this agreement will be replaced with what we find in the document, including the fields you added or moved by hand.</p>
        {unsavedWarning}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming?.kind === "replace"}
        title="Replace the document?"
        confirmLabel="Replace the document"
        onConfirm={() => confirming?.kind === "replace" && replace(confirming.file)}
        onCancel={() => setConfirming(null)}
      >
        <p>
          “{confirming?.kind === "replace" ? confirming.file.name : ""}” will become the document for this agreement. Its fields will be found again from the new
          document, so the fields you placed by hand will be removed.
        </p>
        <p>Agreements you have already sent keep the old document.</p>
        {unsavedWarning}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming?.kind === "archive"}
        title="Archive this agreement?"
        confirmLabel="Archive"
        danger
        onConfirm={archive}
        onCancel={() => setConfirming(null)}
      >
        {view.isDefault ? (
          <p className="font-semibold text-ink">
            This is your default agreement. Once it is archived, nothing is sent on new files until you make another agreement the default.
          </p>
        ) : (
          <p>It will no longer be available to send.</p>
        )}
        {view.intakeUrl ? <p>Its client intake link will stop working.</p> : null}
        <p>Agreements already sent from it are not affected, and you can put it back into use later.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming?.kind === "intake-off"}
        title="Turn off the client intake link?"
        confirmLabel="Turn off the link"
        danger
        onConfirm={() => intake(false)}
        onCancel={() => setConfirming(null)}
      >
        <p>The link stops working at once, wherever you have put it. Turning it on again later gives you a new, different link.</p>
      </ConfirmDialog>
    </section>
  );
}
