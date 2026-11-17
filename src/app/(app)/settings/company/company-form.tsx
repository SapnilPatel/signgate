"use client";

import { useState, useSyncExternalStore } from "react";
import { ActionForm, SubmitButton } from "@/components/form";
import { TextField } from "@/components/text-field";
import { saveCompanyAction } from "../actions";
import { SelectField } from "../parts";

const subscribeToNothing = () => () => {};

function readBrowserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "UTC" ? zone : null;
  } catch {
    return null;
  }
}

export function CompanyForm({
  name,
  legalName,
  timeZone,
  fileReferencePrefix,
  timeZones,
  limits,
}: {
  name: string;
  legalName: string;
  timeZone: string | null;
  fileReferencePrefix: string;
  timeZones: string[];
  limits: { name: number; legalName: number; prefix: number };
}) {
  // With no zone saved yet, offer the one this browser is in. It is only a
  // suggestion until the form is saved, and the hint below says so. Read through
  // an external store so the server render and the first browser render agree.
  const browserZone = useSyncExternalStore(subscribeToNothing, readBrowserZone, () => null);
  const [picked, setPicked] = useState<string | null>(null);
  const zone = picked ?? timeZone ?? browserZone ?? "UTC";
  const suggested = picked === null && !timeZone && browserZone !== null;
  const [prefix, setPrefix] = useState(fileReferencePrefix);

  // Browsers and servers disagree on a few names (Asia/Calcutta and Asia/Kolkata);
  // the current value is always offered so the select never shows a blank.
  const options = ["UTC", ...timeZones.filter((z) => z !== "UTC")];
  if (!options.includes(zone)) options.push(zone);

  const year = new Date().getFullYear();
  const example = `${(prefix.trim() || "F").slice(0, limits.prefix)}-${year}-0001`;

  return (
    <ActionForm action={saveCompanyAction}>
      <TextField
        label="Company name"
        name="name"
        defaultValue={name}
        maxLength={limits.name}
        autoComplete="organization"
        hint="The name your clients know you by. Shown in emails and on the signing page."
      />
      <TextField
        label="Legal name"
        name="legalName"
        defaultValue={legalName}
        maxLength={limits.legalName}
        optional
        hint="The registered name printed on agreements and certificates, if it differs from the company name."
      />
      <SelectField
        label="Time zone"
        name="timeZone"
        value={zone}
        onChange={(e) => {
          setPicked(e.target.value);
        }}
        hint={
          suggested
            ? "Suggested from this browser and not saved yet. Dates printed on agreements use this zone once you save."
            : "Dates printed on agreements, and the year in file references, are calendar days in this zone."
        }
      >
        {options.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </SelectField>
      <TextField
        label="File reference prefix"
        name="fileReferencePrefix"
        value={prefix}
        onChange={(e) => setPrefix(e.target.value)}
        maxLength={limits.prefix}
        className="max-w-40"
        autoCapitalize="characters"
        spellCheck={false}
        hint={
          <>
            New files are numbered like <span className="tabular font-semibold text-ink">{example}</span>. Files you already have keep
            their references.
          </>
        }
      />
      <SubmitButton pendingLabel="Saving…">Save company details</SubmitButton>
    </ActionForm>
  );
}
