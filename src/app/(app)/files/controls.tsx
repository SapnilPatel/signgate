"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button, FormField, Input, Textarea } from "@/components/ui";

/** A labelled text input whose error is passed in, for forms that keep their own action state. */
export function LabelledInput({
  label,
  name,
  hint,
  error,
  optional,
  ...input
}: { label: string; name: string; hint?: ReactNode; error?: string; optional?: boolean } & Omit<ComponentProps<"input">, "name" | "id">) {
  const id = `${useId()}-${name}`;
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} optional={optional}>
      <Input id={id} name={name} aria-invalid={error ? true : undefined} required={!optional} {...input} />
    </FormField>
  );
}

export function LabelledTextarea({
  label,
  name,
  hint,
  error,
  optional,
  ...input
}: { label: string; name: string; hint?: ReactNode; error?: string; optional?: boolean } & Omit<ComponentProps<"textarea">, "name" | "id">) {
  const id = `${useId()}-${name}`;
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} optional={optional}>
      <Textarea id={id} name={name} aria-invalid={error ? true : undefined} required={!optional} {...input} />
    </FormField>
  );
}

/**
 * A signing link with a button that copies it. The link is always visible and
 * selectable too: clipboard access can be refused, and the sender must still be
 * able to take the link.
 */
export function CopyLink({ url, label = "Signing link" }: { url: string; label?: string }) {
  const id = useId();
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (copied === "no") return;
    const timer = setTimeout(() => setCopied("no"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      // Clipboard access was refused: select the text so Ctrl+C or a long press finishes the job.
      input.current?.focus();
      input.current?.select();
      setCopied("failed");
    }
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id={id}
          ref={input}
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-[13px]"
          // A signing link is a secret: keep it out of autofill stores and spellcheck services.
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="secondary" onClick={copy} className="shrink-0">
          {copied === "yes" ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className="mt-1 min-h-5 text-[13px] text-ink-soft" role="status">
        {copied === "yes" ? "Copied. Paste it into an email or message to the signer." : copied === "failed" ? "Your browser did not allow copying. The link is selected: copy it by hand." : ""}
      </p>
    </div>
  );
}

/**
 * A modal that asks before something happens. Built on the browser's own dialog,
 * which traps focus, closes on Escape and returns focus to the button that opened it.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dimmed area around the sheet lands on the dialog element itself.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-[calc(100vw-2rem)] max-w-md rounded-lg border border-rule bg-paper p-0 text-ink shadow-sheet backdrop:bg-ink/40"
    >
      {open ? (
        <div className="p-5 sm:p-6">
          <h2 id={titleId} className="font-serif text-xl font-semibold">
            {title}
          </h2>
          <div className="mt-3 space-y-4 text-sm">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export function DialogButtons({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">{children}</div>;
}
