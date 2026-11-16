"use client";

import type { ComponentProps, ReactNode } from "react";
import { FormField, Input } from "@/components/ui";
import { useFieldError } from "@/components/form";

/** A labelled text input that shows its own server-side validation error. Use inside ActionForm. */
export function TextField({
  label,
  name,
  hint,
  optional,
  ...input
}: { label: string; name: string; hint?: ReactNode; optional?: boolean } & Omit<ComponentProps<"input">, "name" | "id">) {
  const error = useFieldError(name);
  const id = `f-${name}`;
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} optional={optional}>
      <Input id={id} name={name} aria-invalid={error ? true : undefined} required={!optional} {...input} />
    </FormField>
  );
}
