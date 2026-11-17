"use client";

import { useState } from "react";
import type { ActionState } from "@/lib/action";
import { ActionForm, SubmitButton } from "@/components/form";
import { SignaturePad } from "@/components/signature-pad";
import { TextField } from "@/components/text-field";
import { Button, Notice } from "@/components/ui";
import { ActionButton, ResultNotice, useRun } from "../settings/parts";
import {
  changePasswordAction,
  clearSignatureAction,
  saveProfileAction,
  saveSignatureAction,
} from "./actions";

export function ProfileForm({
  name,
  title,
  limits,
}: {
  name: string;
  title: string;
  limits: { name: number; title: number };
}) {
  return (
    <ActionForm action={saveProfileAction}>
      <TextField
        label="Your name"
        name="name"
        defaultValue={name}
        maxLength={limits.name}
        autoComplete="name"
      />
      <TextField
        label="Title"
        name="title"
        defaultValue={title}
        maxLength={limits.title}
        autoComplete="organization-title"
        optional
        hint="For example Partner, Office manager or Mortgage broker."
      />
      <SubmitButton pendingLabel="Saving…">Save your details</SubmitButton>
    </ActionForm>
  );
}

export function PasswordForm({ email }: { email: string }) {
  // Remounted after a success so the typed passwords do not stay in the page.
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {done ? <Notice tone="success">{done}</Notice> : null}
      <ActionForm
        key={round}
        action={async (prev, form) => {
          const result = await changePasswordAction(prev, form);
          if (result?.ok) {
            // The success message has to outlive the remount, so it is kept one level up.
            setDone(result.message ?? "Your password is changed.");
            setRound((n) => n + 1);
            return null;
          }
          setDone(null);
          return result;
        }}
      >
        {/* Lets a password manager attach the new password to the right account. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={email}
          readOnly
          hidden
        />
        <TextField
          label="Current password"
          name="current"
          type="password"
          autoComplete="current-password"
        />
        <TextField
          label="New password"
          name="next"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
        />
        <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
      </ActionForm>
    </div>
  );
}

export function SignatureEditor({
  saved,
  name,
  autoMode,
}: {
  saved: string | null;
  name: string;
  autoMode: boolean;
}) {
  const [editing, setEditing] = useState(saved === null);
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<ActionState>(null);
  const { pending, run } = useRun();

  function save() {
    if (!draft) return;
    run(
      () => saveSignatureAction(draft),
      (r) => {
        setResult(r);
        if (r?.ok) {
          setEditing(false);
          setDraft(null);
        }
      },
    );
  }

  return (
    <div className="space-y-4">
      <ResultNotice result={result} />
      {saved && !editing ? (
        <>
          <div className="flex h-28 items-center justify-center rounded-md border border-rule bg-paper px-6">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the person's own account; nothing to optimize. */}
            <img
              src={saved}
              alt={`Saved signature of ${name}`}
              className="max-h-20 w-auto max-w-full object-contain"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                setEditing(true);
              }}
            >
              Replace signature
            </Button>
            <ActionButton
              size="md"
              variant="danger"
              pendingLabel="Removing…"
              action={clearSignatureAction}
              onResult={(r) => {
                setResult(r);
                if (r?.ok) setEditing(true);
              }}
              confirm={{
                title: "Remove your saved signature?",
                body: autoMode
                  ? "Agreements will stop being countersigned automatically. After each client signs, you will be emailed to sign it yourself, until you save a signature again."
                  : "You will draw or type your signature each time you countersign, until you save one again.",
                confirmLabel: "Remove signature",
                danger: true,
              }}
            >
              Remove
            </ActionButton>
          </div>
        </>
      ) : (
        <>
          <SignaturePad value={draft} onChange={setDraft} defaultName={name} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={save}
              disabled={!draft || pending}
              aria-busy={pending}
            >
              {pending
                ? "Saving…"
                : saved
                  ? "Save new signature"
                  : "Save signature"}
            </Button>
            {saved ? (
              <Button
                variant="quiet"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setDraft(null);
                }}
              >
                Keep the current one
              </Button>
            ) : null}
            {!draft ? (
              <span className="text-[13px] text-ink-soft">
                Draw, type or upload your signature above, then save it.
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
