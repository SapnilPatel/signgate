"use client";

import { startTransition, useActionState, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action";
import { Button, ButtonLink, Notice, Sheet } from "@/components/ui";
import type { AgreementOutcome } from "../../action-types";
import { correctSignerAction, updateFileAction } from "../../actions";
import { CopyLink, LabelledInput, LabelledTextarea } from "../../controls";

interface EditableFile {
  id: string;
  clientName: string;
  clientEmail: string;
  clientCompany: string;
  clientTitle: string;
  clientPhone: string;
  description: string;
  reference: string;
}

/**
 * Shown after a save that changed the client's name or email while an agreement is
 * still out: the link they hold carries the old details, and only the sender can
 * say whether it should be replaced.
 */
function Reissue({ fileId, reissue }: { fileId: string; reissue: { signerId: string; name: string; email: string } }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionState<AgreementOutcome>>(null);

  function send() {
    if (pending) return;
    start(async () => {
      try {
        setResult(await correctSignerAction(reissue.signerId, reissue.name, reissue.email));
      } catch {
        setResult({ ok: false, error: "The request did not reach the server. Check your connection and try again." });
      }
    });
  }

  if (result?.ok && result.data) {
    return (
      <Sheet className="space-y-5 p-5 sm:p-8">
        <Notice tone={result.data.tone}>{result.data.message}</Notice>
        {result.data.signingUrl ? <CopyLink url={result.data.signingUrl} label={`New signing link for ${reissue.name}`} /> : null}
        <ButtonLink href={`/files/${fileId}`}>Back to the file</ButtonLink>
      </Sheet>
    );
  }

  return (
    <Sheet className="space-y-5 p-5 sm:p-8">
      <div>
        <h2 className="font-serif text-xl font-semibold">The details were saved. Send a new signing link too?</h2>
        <p className="mt-2 text-ink-soft">
          The agreement that is out for signature was sent with the old name or email. Sending a new link moves it to {reissue.name} at{" "}
          <span className="break-all">{reissue.email}</span> and stops the old link working. If you leave it, the old link keeps working and the agreement keeps the old details.
        </p>
      </div>
      {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button disabled={pending} aria-busy={pending} onClick={send}>
          {pending ? "Sending the new link…" : "Send a new signing link"}
        </Button>
        <ButtonLink href={`/files/${fileId}?saved=1`} variant="secondary" aria-disabled={pending}>
          Leave the agreement as it is
        </ButtonLink>
      </div>
    </Sheet>
  );
}

export function EditFileForm({ file }: { file: EditableFile }) {
  const [state, formAction, pending] = useActionState(updateFileAction, null);

  if (state?.ok && state.data?.reissue) return <Reissue fileId={file.id} reissue={state.data.reissue} />;

  const errors = state && !state.ok ? (state.fields ?? {}) : {};
  return (
    <Sheet className="p-5 sm:p-8">
      <form
        action={formAction}
        // Submitting by hand keeps what was typed when the server answers with an error.
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const data = new FormData(event.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="space-y-4"
        noValidate
      >
        {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}
        <input type="hidden" name="id" value={file.id} />
        <LabelledInput label="Client name" name="clientName" defaultValue={file.clientName} error={errors.clientName} autoComplete="off" maxLength={200} />
        <LabelledInput label="Client email" name="clientEmail" type="email" inputMode="email" defaultValue={file.clientEmail} error={errors.clientEmail} autoComplete="off" maxLength={254} />
        <div className="grid gap-4 sm:grid-cols-2">
          <LabelledInput label="Company" name="clientCompany" optional defaultValue={file.clientCompany} error={errors.clientCompany} autoComplete="off" maxLength={200} />
          <LabelledInput label="Title" name="clientTitle" optional defaultValue={file.clientTitle} error={errors.clientTitle} autoComplete="off" maxLength={120} />
        </div>
        <LabelledInput label="Phone" name="clientPhone" type="tel" optional defaultValue={file.clientPhone} error={errors.clientPhone} autoComplete="off" maxLength={40} />
        <LabelledInput label="File reference" name="reference" defaultValue={file.reference} error={errors.reference} autoComplete="off" maxLength={64} />
        <LabelledTextarea label="Notes" name="description" optional defaultValue={file.description} error={errors.description} maxLength={2000} rows={4} />
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <ButtonLink href={`/files/${file.id}`} variant="quiet">
            Cancel
          </ButtonLink>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
