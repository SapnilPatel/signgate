"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import type { ActionState } from "@/lib/action";
import { Button, FormField, Input, Notice, Select, Textarea, buttonClass } from "@/components/ui";
import type { AgreementOutcome } from "../action-types";
import {
  archiveFileAction,
  correctSignerAction,
  countersignAction,
  remindAction,
  resendAction,
  restoreFileAction,
  retryFinalCopyAction,
  sendAgreementAction,
  signingLinkAction,
  voidAction,
} from "../actions";
import { CopyLink, Dialog, DialogButtons } from "../controls";

/**
 * Everything the panel may offer, decided on the server from the agreement's state.
 * The panel only draws it: a button that is not in the model is not on the screen.
 */
export interface PanelModel {
  fileId: string;
  clientName: string;
  orgName: string;
  /** Present when nothing is out for signature and nothing is signed. */
  send: {
    label: string;
    to: string;
    agreementName: string | null;
    /** Why nothing can be sent right now; the button is replaced by this. */
    blocked: string | null;
    /** Where an owner or admin fixes `blocked`; null for people who cannot. */
    fixHref: string | null;
    /** Set when the agreement will be prepared but not emailed. */
    emailNote: string | null;
  } | null;
  /** Present while an agreement is out for signature or being finished. */
  open: {
    envelopeId: string;
    stage: "draft" | "with_client" | "with_company" | "sealing";
    /** The expiry date has passed; the link is dead even though the scheduler has not closed it yet. */
    lapsed: boolean;
    client: { signerId: string; name: string; email: string; signingUrl: string | null } | null;
    /** The company signer's id, when the person looking may sign for the company now. */
    countersignerId: string | null;
    /** The countersigner's name, when someone else has to sign and can be nudged. */
    remindName: string | null;
    replaceBlocked: string | null;
    /** False when the account has no way to send email: buttons that only email are left out. */
    canEmail: boolean;
  } | null;
  documents: { label: string; href: string; primary?: boolean }[];
  /**
   * The agreements that can be sent now, the default first. A choice is drawn only when
   * there is more than one; `preferredId` is the one this file last had, when it is still among them.
   */
  agreements: { id: string; name: string }[];
  preferredId: string | null;
}

/**
 * For buttons whose label carries a name the company typed (its own name, a colleague's):
 * the shared button is a single unbreakable line, which pushes a long name off a phone screen.
 */
const WRAPS = "h-auto! max-w-full py-2 text-left whitespace-normal! [overflow-wrap:anywhere]";

type Result = ActionState<AgreementOutcome>;
type Asking = "correct" | "void" | "replace" | null;

export function AgreementPanel({ model }: { model: PanelModel }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [dialogError, setDialogError] = useState<{ message: string; fields: Record<string, string> } | null>(null);

  const { send, open, agreements } = model;
  const agreementField = useId();
  const [picked, setPicked] = useState<string | null>(null);
  // What was picked wins while it can still be sent; otherwise the file's last agreement, then the default.
  const agreement = agreements.find((a) => a.id === picked) ?? agreements.find((a) => a.id === model.preferredId) ?? agreements[0] ?? null;
  // With a single agreement nothing is passed and the service uses the company default, as before.
  const templateId = agreements.length > 1 ? agreement?.id : undefined;
  const picker = (id: string, hint: string) =>
    agreements.length > 1 ? (
      <FormField label="Agreement" htmlFor={id} hint={hint}>
        <Select id={id} value={agreement?.id ?? ""} disabled={pending} onChange={(event) => setPicked(event.target.value)} className="sm:max-w-md">
          {agreements.map((choice, index) => (
            <option key={choice.id} value={choice.id}>
              {index === 0 ? `${choice.name} (default)` : choice.name}
            </option>
          ))}
        </Select>
      </FormField>
    ) : null;
  const client = open?.client ?? null;

  /**
   * Runs one action at a time. While it runs every button is off, so a double click
   * or an impatient second button cannot send twice. `inDialog` keeps a failure inside
   * the dialog that asked, next to the fields it is about.
   */
  function run(name: string, action: () => Promise<Result>, inDialog = false) {
    if (pending) return;
    setBusy(name);
    setDialogError(null);
    if (!inDialog) setResult(null);
    startTransition(async () => {
      let outcome: Result;
      try {
        outcome = await action();
      } catch {
        outcome = { ok: false, error: "The request did not reach the server. Check your connection and try again." };
      }
      setBusy(null);
      if (outcome && !outcome.ok) {
        // The page may be out of date (the client signed, someone else voided it): show what is true now.
        router.refresh();
        if (inDialog) {
          setDialogError({ message: outcome.error, fields: outcome.fields ?? {} });
          return;
        }
      }
      setAsking(null);
      setResult(outcome);
    });
  }

  const ask = (what: Asking) => {
    setDialogError(null);
    setAsking(what);
  };
  const label = (name: string, idle: string, working: string) => (busy === name ? working : idle);
  const outcome = result?.ok ? result.data : undefined;
  const extraLink = outcome?.signingUrl && outcome.signingUrl !== client?.signingUrl ? outcome.signingUrl : null;
  const awaitingClient = open?.stage === "draft" || open?.stage === "with_client";

  return (
    <div className="mt-5 space-y-5">
      <div aria-live="polite" className="space-y-3 empty:hidden">
        {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}
        {outcome ? <Notice tone={outcome.tone}>{outcome.message}</Notice> : null}
        {extraLink ? <CopyLink url={extraLink} /> : null}
      </div>

      {send ? (
        send.blocked ? (
          <Notice tone="info" title="The agreement cannot be sent yet">
            <p>
              {send.blocked}{" "}
              {send.fixHref ? <Link href={send.fixHref}>{send.fixHref === "/agreements/new" ? "Upload your agreement" : "Fix it under Agreements"}</Link> : "Ask an owner or admin of your company to set it up."}
            </p>
          </Notice>
        ) : (
          <div className="space-y-3">
            {picker(`${agreementField}-send`, "Your company has more than one agreement in use. This one is sent for this file.")}
            <Button disabled={pending} aria-busy={busy === "send"} onClick={() => run("send", () => sendAgreementAction(model.fileId, { templateId }))}>
              {label("send", send.label, "Sending…")}
            </Button>
            <p className="text-[13px] [overflow-wrap:anywhere] text-ink-soft">
              {send.emailNote
                ? `"${agreement?.name ?? send.agreementName}" will be prepared for ${send.to}. ${send.emailNote}`
                : `"${agreement?.name ?? send.agreementName}" will be emailed to ${send.to} for signature.`}
            </p>
          </div>
        )
      ) : null}

      {open?.countersignerId ? (
        <div>
          <Button size="lg" className={WRAPS} disabled={pending} aria-busy={busy === "countersign"} onClick={() => run("countersign", () => countersignAction(open.countersignerId as string))}>
            {label("countersign", `Sign for ${model.orgName}`, "Opening the agreement…")}
          </Button>
        </div>
      ) : null}

      {open?.stage === "sealing" ? (
        <div>
          <Button variant="secondary" disabled={pending} aria-busy={busy === "retry"} onClick={() => run("retry", () => retryFinalCopyAction(open.envelopeId))}>
            {label("retry", "Retry producing the final copy", "Producing the final copy…")}
          </Button>
        </div>
      ) : null}

      {client?.signingUrl ? <CopyLink url={client.signingUrl} label={`Signing link for ${client.name}`} /> : null}

      {open?.lapsed && open.replaceBlocked ? (
        <Notice tone="info" title="A fresh copy cannot be sent yet">
          <p>{open.replaceBlocked}</p>
        </Notice>
      ) : null}

      {open && open.stage !== "sealing" ? (
        <div className="flex flex-wrap gap-2">
          {open.lapsed ? (
            <Button disabled={pending || Boolean(open.replaceBlocked)} onClick={() => ask("replace")}>
              Send a fresh copy
            </Button>
          ) : null}
          {open.stage === "with_client" && !open.lapsed && open.canEmail ? (
            <Button variant="secondary" disabled={pending} aria-busy={busy === "remind"} onClick={() => run("remind", () => remindAction(open.envelopeId))}>
              {label("remind", "Send a reminder now", "Sending the reminder…")}
            </Button>
          ) : null}
          {client && !open.lapsed && open.canEmail ? (
            <Button variant="secondary" disabled={pending} aria-busy={busy === "resend"} onClick={() => run("resend", () => resendAction(client.signerId))}>
              {label("resend", open.stage === "draft" ? "Email the request" : "Resend the email", "Sending…")}
            </Button>
          ) : null}
          {client && !client.signingUrl && !open.lapsed ? (
            <Button variant="secondary" disabled={pending} aria-busy={busy === "link"} onClick={() => run("link", () => signingLinkAction(client.signerId))}>
              {label("link", "Show the signing link", "Getting the link…")}
            </Button>
          ) : null}
          {open.remindName && open.canEmail ? (
            <Button variant="secondary" className={WRAPS} disabled={pending} aria-busy={busy === "remind"} onClick={() => run("remind", () => remindAction(open.envelopeId))}>
              {label("remind", `Send ${open.remindName} a reminder`, "Sending the reminder…")}
            </Button>
          ) : null}
          {client && !open.lapsed ? (
            <Button variant="secondary" disabled={pending} onClick={() => ask("correct")}>
              Correct name or email
            </Button>
          ) : null}
          {awaitingClient && !open.lapsed && !open.replaceBlocked ? (
            <Button variant="secondary" disabled={pending} onClick={() => ask("replace")}>
              Send a fresh copy
            </Button>
          ) : null}
          <Button variant="danger" disabled={pending} onClick={() => ask("void")}>
            Void agreement
          </Button>
        </div>
      ) : null}

      {model.documents.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule-soft pt-4 text-sm">
          {model.documents.map((doc) =>
            doc.primary ? (
              <a key={doc.href} href={doc.href} className={buttonClass("primary")}>
                {doc.label}
              </a>
            ) : (
              <a key={doc.href} href={doc.href} target={doc.href.includes("download=1") ? undefined : "_blank"} rel="noreferrer" className="font-semibold text-ink underline">
                {doc.label}
              </a>
            ),
          )}
        </div>
      ) : null}

      {client ? (
        <CorrectDialog
          // A fresh form each time it opens, starting from what is on file now.
          key={`${asking === "correct"}-${client.name}-${client.email}`}
          open={asking === "correct"}
          client={client}
          pending={pending}
          error={dialogError}
          onClose={() => setAsking(null)}
          onSubmit={(name, email) => run("correct", () => correctSignerAction(client.signerId, name, email), true)}
        />
      ) : null}

      {open ? (
        <VoidDialog
          key={`void-${asking === "void"}`}
          open={asking === "void"}
          clientName={model.clientName}
          clientSigned={open.stage === "with_company"}
          pending={pending}
          error={dialogError?.message ?? null}
          onClose={() => setAsking(null)}
          onSubmit={(reason, includeSigned) => run("void", () => voidAction(open.envelopeId, reason, includeSigned), true)}
        />
      ) : null}

      {open ? (
        <Dialog open={asking === "replace"} title="Send a fresh copy of the agreement?" onClose={() => setAsking(null)}>
          <p className="text-ink-soft">
            The request that is out now is voided, so the link {model.clientName} already has stops working. A new request is made from{" "}
            {agreements.length > 1 ? "the agreement chosen below" : "your agreement"} as it is today and sent to {client?.email ?? "the client"}.
          </p>
          {picker(`${agreementField}-replace`, "The fresh copy is made from this agreement.")}
          {dialogError ? <Notice tone="error">{dialogError.message}</Notice> : null}
          <DialogButtons>
            <Button variant="secondary" disabled={pending} onClick={() => setAsking(null)}>
              Keep the current request
            </Button>
            <Button
              disabled={pending}
              aria-busy={busy === "replace"}
              // The id of the request on screen makes a repeated click return the first replacement instead of replacing that too.
              onClick={() => run("replace", () => sendAgreementAction(model.fileId, { templateId, replace: true, replaceEnvelopeId: open.envelopeId }), true)}
            >
              {label("replace", "Void it and send a fresh copy", "Sending…")}
            </Button>
          </DialogButtons>
        </Dialog>
      ) : null}
    </div>
  );
}

function CorrectDialog({
  open,
  client,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  client: { name: string; email: string };
  pending: boolean;
  error: { message: string; fields: Record<string, string> } | null;
  onClose: () => void;
  onSubmit: (name: string, email: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email);
  const unchanged = name.trim() === client.name && email.trim().toLowerCase() === client.email.toLowerCase();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!pending && !unchanged) onSubmit(name, email);
  }

  return (
    <Dialog open={open} title="Correct the client's name or email" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-ink-soft">
          The link already sent stops working and a new one goes to the corrected address. The file is updated to match.
        </p>
        {error && Object.keys(error.fields).length === 0 ? <Notice tone="error">{error.message}</Notice> : null}
        <FormField label="Client name" htmlFor={`${id}-name`} error={error?.fields.name}>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" aria-invalid={error?.fields.name ? true : undefined} />
        </FormField>
        <FormField label="Client email" htmlFor={`${id}-email`} error={error?.fields.email}>
          <Input id={`${id}-email`} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" aria-invalid={error?.fields.email ? true : undefined} />
        </FormField>
        <DialogButtons>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || unchanged} aria-busy={pending}>
            {pending ? "Saving…" : "Save and send a new link"}
          </Button>
        </DialogButtons>
      </form>
    </Dialog>
  );
}

function VoidDialog({
  open,
  clientName,
  clientSigned,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  clientName: string;
  clientSigned: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (reason: string, includeSigned: boolean) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [discard, setDiscard] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || (clientSigned && !discard)) return;
    // Only ever true after the box below was ticked by the person voiding.
    onSubmit(reason, clientSigned && discard);
  }

  return (
    <Dialog open={open} title="Void this agreement?" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-ink-soft">
          {clientSigned
            ? `${clientName} has already signed. Voiding throws that signature away: to get the agreement signed, you would have to send it again and they would have to sign again.`
            : `The signing link stops working at once and ${clientName} is told the request was cancelled. You can send the agreement again later.`}
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <FormField label="Reason" htmlFor={`${id}-reason`} optional hint="Kept on the file's timeline for your team.">
          <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} className="min-h-20" />
        </FormField>
        {clientSigned ? (
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" />
            <span>I understand this discards {clientName}&rsquo;s signature.</span>
          </label>
        ) : null}
        <DialogButtons>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            Keep the agreement
          </Button>
          <Button type="submit" variant="danger" disabled={pending || (clientSigned && !discard)} aria-busy={pending}>
            {pending ? "Voiding…" : "Void agreement"}
          </Button>
        </DialogButtons>
      </form>
    </Dialog>
  );
}

/** Archive (after asking) or restore, in the page header. */
export function FileArchiveButton({
  fileId,
  archived,
  hasOpenAgreement,
  clientSigned,
  clientName,
}: {
  fileId: string;
  archived: boolean;
  hasOpenAgreement: boolean;
  clientSigned: boolean;
  clientName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<Result>) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      let outcome: Result;
      try {
        outcome = await action();
      } catch {
        outcome = { ok: false, error: "The request did not reach the server. Check your connection and try again." };
      }
      if (outcome && !outcome.ok) setError(outcome.error);
      else setAsking(false);
    });
  }

  if (archived) {
    return (
      <>
        <Button variant="secondary" disabled={pending} aria-busy={pending} onClick={() => run(() => restoreFileAction(fileId))}>
          {pending ? "Restoring…" : "Restore file"}
        </Button>
        {error ? (
          <p role="alert" className="w-full text-[13px] text-stop">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Button variant="secondary" disabled={pending} onClick={() => setAsking(true)}>
        Archive
      </Button>
      <Dialog open={asking} title="Archive this file?" onClose={() => setAsking(false)}>
        <p className="text-ink-soft">
          It leaves your working list and is kept under Archived, where you can restore it.{" "}
          {clientSigned
            ? `${clientName} has already signed the agreement on this file. Archiving voids it and throws that signature away.`
            : hasOpenAgreement
              ? `The agreement that is out for signature is voided, so ${clientName}'s signing link stops working.`
              : "Signed copies and the timeline are kept."}
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <DialogButtons>
          <Button variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
            Keep it in my list
          </Button>
          <Button variant={hasOpenAgreement ? "danger" : "primary"} disabled={pending} aria-busy={pending} onClick={() => run(() => archiveFileAction(fileId))}>
            {pending ? "Archiving…" : hasOpenAgreement ? "Archive and void the agreement" : "Archive file"}
          </Button>
        </DialogButtons>
      </Dialog>
    </>
  );
}
