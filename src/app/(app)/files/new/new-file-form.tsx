"use client";

import Link from "next/link";
import { startTransition, useActionState, useId, useState } from "react";
import { Button, ButtonLink, FormField, Notice, Select, Sheet } from "@/components/ui";
import type { CreateFileOutcome } from "../action-types";
import { createFileAction } from "../actions";
import { CopyLink, LabelledInput, LabelledTextarea } from "../controls";
import type { SendingOutlook } from "../outlook";

/** What saving will do, said before the button is pressed. */
function Plan({ outlook, manager, skip, email, name }: { outlook: SendingOutlook; manager: boolean; skip: boolean; email: string; name: string }) {
  if (outlook.blocked) {
    return (
      <Notice tone="info" title="No agreement will be sent for this file yet">
        <p>
          {outlook.blocked}{" "}
          {manager ? (
            <>
              <Link href={outlook.needsAgreement ? "/agreements/new" : "/agreements"}>{outlook.needsAgreement ? "Upload your agreement" : "Fix it under Agreements"}</Link>, then send it from the file.
            </>
          ) : (
            "Ask an owner or admin of your company to set it up, then send it from the file."
          )}
        </p>
      </Notice>
    );
  }
  if (skip) {
    return (
      <Notice tone="info" title="Nothing will be sent">
        <p>The file is created and &ldquo;{name}&rdquo; stays unsent. Send it from the file when you are ready.</p>
      </Notice>
    );
  }
  if (outlook.email === "ok") {
    const to = email.trim();
    return (
      <Notice tone="info" title="What happens when you save">
        <p>
          The agreement &ldquo;{name}&rdquo; will be emailed to {to ? <strong className="break-all text-ink">{to}</strong> : "this address"} for signature. You also get the signing link, in case you want to send it yourself.
        </p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title="The agreement will not be emailed">
      <p>
        {outlook.email === "not_configured"
          ? `Email is not set up for this account, so "${name}" is prepared but not emailed.`
          : `"${name}" is prepared but not emailed. ${outlook.emailReason ?? "Your company's owner has not confirmed their email address yet."}`}{" "}
        You get a signing link to send to the client yourself.
      </p>
    </Notice>
  );
}

function Outcome({ outcome, onAnother }: { outcome: CreateFileOutcome; onAnother: () => void }) {
  const { agreement } = outcome;
  return (
    <Sheet className="space-y-5 p-5 sm:p-8">
      <div>
        <h2 className="font-serif text-xl font-semibold" tabIndex={-1} ref={(node) => node?.focus()}>
          {outcome.created ? `File ${outcome.reference} was created` : `File ${outcome.reference} already existed`}
        </h2>
        <p className="mt-1 text-ink-soft">
          {outcome.clientName}, <span className="break-all">{outcome.clientEmail}</span>
        </p>
      </div>

      {agreement.sent && agreement.emailed ? (
        <Notice tone="success" title="The agreement was emailed">
          <p>
            It went to <span className="break-all">{outcome.clientEmail}</span>. The client is reminded automatically until they sign.
          </p>
        </Notice>
      ) : agreement.sent ? (
        <Notice tone="warning" title="The agreement is ready to sign, but it was not emailed">
          <p>{agreement.reason ?? "Copy the signing link below and send it to the client yourself."}</p>
        </Notice>
      ) : (
        <Notice tone="info" title="The agreement was not sent">
          <p>{agreement.reason ?? "Send it from the file when you are ready."}</p>
        </Notice>
      )}

      {agreement.signingUrl ? (
        <CopyLink url={agreement.signingUrl} label={`Signing link for ${outcome.clientName}`} />
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <ButtonLink href={`/files/${outcome.fileId}`}>Open the file</ButtonLink>
        <Button variant="secondary" onClick={onAnother}>
          Create another file
        </Button>
        <ButtonLink href="/files" variant="quiet">
          Back to all files
        </ButtonLink>
      </div>
    </Sheet>
  );
}

export function NewFileForm({ outlook, manager }: { outlook: SendingOutlook; manager: boolean }) {
  const [state, formAction, pending] = useActionState(createFileAction, null);
  const [skip, setSkip] = useState(!outlook.autoSend);
  const [email, setEmail] = useState("");
  // The result on screen belongs to one submission; "Create another file" moves past it.
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [formKey, setFormKey] = useState(0);
  // Offered only when the company has more than one agreement it could send; the default comes first.
  const [agreementId, setAgreementId] = useState(outlook.choices[0]?.id ?? "");
  const agreementField = useId();
  const chosen = outlook.choices.find((c) => c.id === agreementId) ?? outlook.choices[0];

  if (state?.ok && state.data && dismissed !== state) {
    return (
      <Outcome
        outcome={state.data}
        onAnother={() => {
          setDismissed(state);
          setEmail("");
          setSkip(!outlook.autoSend);
          setAgreementId(outlook.choices[0]?.id ?? "");
          setFormKey((k) => k + 1);
        }}
      />
    );
  }

  const errors = state && !state.ok ? (state.fields ?? {}) : {};
  const willSend = !outlook.blocked && !skip;

  return (
    <Sheet className="p-5 sm:p-8">
      <form
        key={formKey}
        action={formAction}
        // Submitting by hand keeps what was typed when the server answers with an error.
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const data = new FormData(event.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="space-y-5"
        noValidate
      >
        {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}

        <section aria-labelledby="new-file-client" className="space-y-4">
          <h2 id="new-file-client" className="text-base font-semibold text-ink">
            Client
          </h2>
          <LabelledInput label="Client name" name="clientName" error={errors.clientName} autoComplete="off" maxLength={200} hint="The person who signs, as it should appear on the agreement." />
          <LabelledInput
            label="Client email"
            name="clientEmail"
            type="email"
            inputMode="email"
            error={errors.clientEmail}
            autoComplete="off"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <LabelledInput label="Company" name="clientCompany" optional error={errors.clientCompany} autoComplete="off" maxLength={200} />
            <LabelledInput label="Title" name="clientTitle" optional error={errors.clientTitle} autoComplete="off" maxLength={120} />
          </div>
          <LabelledInput label="Phone" name="clientPhone" type="tel" optional error={errors.clientPhone} autoComplete="off" maxLength={40} />
        </section>

        <section aria-labelledby="new-file-file" className="space-y-4 border-t border-rule-soft pt-5">
          <h2 id="new-file-file" className="text-base font-semibold text-ink">
            File
          </h2>
          <LabelledInput
              label="File reference"
              name="reference"
              optional
              error={errors.reference}
              autoComplete="off"
              maxLength={64}
              hint="Your own file or matter number. Leave it empty and one is generated."
            />
          <LabelledTextarea label="Notes" name="description" optional error={errors.description} maxLength={2000} rows={3} hint="What the job is. Only your team sees this, unless your agreement prints it." />
        </section>

        <div className="space-y-3 border-t border-rule-soft pt-5">
          {outlook.blocked ? null : (
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" name="skipSend" checked={skip} onChange={(event) => setSkip(event.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" />
              <span>Create the file without sending the agreement</span>
            </label>
          )}
          {willSend && outlook.choices.length > 1 ? (
            <FormField label="Agreement" htmlFor={agreementField} hint="Your company has more than one agreement in use. This one is sent for this file.">
              <Select id={agreementField} name="templateId" value={chosen?.id ?? ""} onChange={(event) => setAgreementId(event.target.value)}>
                {outlook.choices.map((choice, index) => (
                  <option key={choice.id} value={choice.id}>
                    {index === 0 ? `${choice.name} (default)` : choice.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <Plan outlook={outlook} manager={manager} skip={skip} email={email} name={chosen?.name ?? outlook.agreement?.name ?? "Your agreement"} />
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <ButtonLink href="/files" variant="quiet">
            Cancel
          </ButtonLink>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? (willSend ? "Creating the file and sending…" : "Creating the file…") : willSend ? "Create file and send agreement" : "Create file"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
