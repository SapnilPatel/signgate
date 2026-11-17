"use client";

import type { CSSProperties } from "react";
import { ActionForm, SubmitButton, useFormState } from "@/components/form";
import { TextField } from "@/components/text-field";
import { startIntakeAction } from "./actions";

function Fields({ token, buttonStyle }: { token: string; buttonStyle: CSSProperties }) {
  const { state } = useFormState();
  // Once the request is accepted without a link to go to, the form has done its job.
  if (state?.ok) return null;
  return (
    <>
      <input type="hidden" name="token" value={token} />
      <TextField label="Your full name" name="clientName" autoComplete="name" maxLength={200} className="h-12 text-base" hint="As it should appear on the agreement." />
      <TextField
        label="Email address"
        name="clientEmail"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        className="h-12 text-base"
        hint="Your signed copy is sent here."
      />
      <TextField label="Company" name="clientCompany" optional autoComplete="organization" maxLength={200} className="h-12 text-base" />
      <TextField label="Phone" name="clientPhone" optional type="tel" inputMode="tel" autoComplete="tel" maxLength={40} className="h-12 text-base" />
      {/* Not for people: hidden from sight, from the keyboard and from screen readers. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="contact_preference_note">Leave this empty</label>
        <input id="contact_preference_note" name="contact_preference_note" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <div style={buttonStyle} className="rounded-md">
        <SubmitButton size="lg" pendingLabel="Preparing your agreement…" className="w-full !bg-transparent !text-inherit">
          Continue to the agreement
        </SubmitButton>
      </div>
    </>
  );
}

export function IntakeForm({ token, buttonStyle }: { token: string; buttonStyle: CSSProperties }) {
  return (
    <ActionForm action={startIntakeAction} className="relative space-y-4">
      <Fields token={token} buttonStyle={buttonStyle} />
    </ActionForm>
  );
}
