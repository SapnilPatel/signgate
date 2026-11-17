"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionForm, SubmitButton, useFieldError } from "@/components/form";
import { TextField } from "@/components/text-field";
import { saveCountersigningAction, saveSendingAction } from "../actions";
import { SelectField, TextareaField } from "../parts";

export function SendingForm({
  autoSend,
  reminderEveryDays,
  maxReminders,
  expireAfterDays,
  emailMessage,
  replyToEmail,
  messageMax,
}: {
  autoSend: boolean;
  reminderEveryDays: number;
  maxReminders: number;
  expireAfterDays: number;
  emailMessage: string;
  replyToEmail: string;
  messageMax: number;
}) {
  const [message, setMessage] = useState(emailMessage);
  return (
    <ActionForm action={saveSendingAction} className="space-y-5">
      <label className="flex items-start gap-3">
        <input type="checkbox" name="autoSendOnFileCreate" defaultChecked={autoSend} className="mt-1 size-4 shrink-0 accent-ink" />
        <span>
          <span className="block text-sm font-semibold text-ink">Send the agreement as soon as a file is created</span>
          <span className="block text-[13px] text-ink-soft">
            Your default agreement goes to the client straight away. Turn this off to review each file first and press Send agreement
            yourself.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Remind every"
          name="reminderEveryDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={30}
          defaultValue={reminderEveryDays}
          hint="Days between reminders. 0 sends none."
        />
        <TextField
          label="Stop after"
          name="maxReminders"
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          defaultValue={maxReminders}
          hint="Reminders per agreement, at most."
        />
        <TextField
          label="Link expires after"
          name="expireAfterDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          defaultValue={expireAfterDays}
          hint="Days. 0 means it never expires."
        />
      </div>

      <TextareaField
        label="Message in the request email"
        name="emailMessage"
        optional
        rows={4}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={messageMax}
        hint={
          <span className="flex justify-between gap-4">
            <span>Added to the email that asks a client to sign, in your own words. Leave it empty to send the standard wording only.</span>
            <span className="tabular shrink-0">
              {message.length} of {messageMax}
            </span>
          </span>
        }
      />
      <TextField
        label="Reply-to address"
        name="replyToEmail"
        type="email"
        inputMode="email"
        autoComplete="email"
        optional
        defaultValue={replyToEmail}
        hint="When a client replies to an agreement email, the reply goes here. Leave it empty and replies go to the address the emails are sent from, which may not be an inbox anyone reads."
      />
      <SubmitButton pendingLabel="Saving…">Save sending settings</SubmitButton>
    </ActionForm>
  );
}

interface Candidate {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  hasSignature: boolean;
}

export function CountersigningForm({
  members,
  ownerName,
  viewerId,
  countersignerUserId,
  mode: initialMode,
}: {
  members: Candidate[];
  ownerName: string | null;
  viewerId: string;
  countersignerUserId: string;
  mode: "auto" | "manual";
}) {
  const [chosen, setChosen] = useState(countersignerUserId);
  const [mode, setMode] = useState(initialMode);
  // With nobody chosen the owner countersigns; that is the service's rule, shown here so the default is not a mystery.
  const person = members.find((m) => m.id === chosen) ?? (chosen === "" ? (members.find((m) => m.role === "owner") ?? null) : null);
  const missingSignature = mode === "auto" && person !== null && !person.hasSignature;
  // "The owner" is stored as no choice at all, which the service accepts for manual signing
  // but not for automatic, where it needs a named person whose saved signature it applies.
  // In automatic mode that option therefore carries the owner's own id, so the default works in both.
  const ownerValue = mode === "auto" && chosen === "" && person ? person.id : "";

  return (
    <ActionForm action={saveCountersigningAction} className="space-y-5">
      <SelectField
        label="Who countersigns"
        name="countersignerUserId"
        value={chosen === "" ? ownerValue : chosen}
        onChange={(e) => setChosen(e.target.value === ownerValue ? "" : e.target.value)}
        hint="Anyone on your team who is allowed to sign for the company."
      >
        <option value={ownerValue}>{ownerName ? `The owner (${ownerName})` : "The owner"}</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.hasSignature ? "" : " (no saved signature)"}
          </option>
        ))}
      </SelectField>

      <ModeChoice mode={mode} onChange={setMode} />

      {missingSignature && person ? (
        <p className="rounded-md border border-rule bg-desk px-4 py-3 text-sm text-ink-soft">
          {person.id === viewerId ? (
            <>
              Automatic countersigning uses your saved signature, and you have not saved one yet.{" "}
              <Link href="/account#signature" className="font-semibold text-ink underline">
                Save your signature
              </Link>
              , then come back and save this.
            </>
          ) : (
            <>
              Automatic countersigning uses {person.name}&rsquo;s saved signature, and they have not saved one yet. Ask them to sign in,
              open their account and save a signature; until then, choose the other option.
            </>
          )}
        </p>
      ) : null}

      <SubmitButton pendingLabel="Saving…">Save countersigning</SubmitButton>
    </ActionForm>
  );
}

function ModeChoice({ mode, onChange }: { mode: "auto" | "manual"; onChange: (mode: "auto" | "manual") => void }) {
  const error = useFieldError("countersignMode");
  const options = [
    {
      value: "manual" as const,
      title: "They sign each one",
      detail: "After the client signs, the countersigner gets an email, reads the agreement and signs it themselves.",
    },
    {
      value: "auto" as const,
      title: "Apply their saved signature automatically",
      detail: "The moment the client signs, the countersigner's saved signature is placed on the agreement and it is complete, with nobody needing to act.",
    },
  ];
  return (
    <fieldset className="space-y-2" aria-describedby={error ? "countersignMode-error" : undefined}>
      <legend className="mb-1.5 text-sm font-semibold text-ink">How they sign</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={
            "flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 " +
            (mode === option.value ? "border-ink bg-paper" : "border-rule hover:border-ink-faint")
          }
        >
          <input
            type="radio"
            name="countersignMode"
            value={option.value}
            checked={mode === option.value}
            onChange={() => onChange(option.value)}
            className="mt-1 size-4 shrink-0 accent-ink"
          />
          <span>
            <span className="block text-sm font-semibold text-ink">{option.title}</span>
            <span className="block text-[13px] text-ink-soft">{option.detail}</span>
          </span>
        </label>
      ))}
      {error ? (
        <p id="countersignMode-error" className="text-[13px] text-stop" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
