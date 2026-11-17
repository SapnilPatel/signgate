"use client";

/**
 * Client building blocks shared by the settings, account and welcome screens:
 * buttons that run one server action (asking first when the action is
 * destructive), a copy-to-clipboard field for links and keys that are shown
 * once, and labelled controls that show their own server-side error.
 */
import { useEffect, useId, useRef, useState, useTransition, type ComponentProps, type ReactNode } from "react";
import type { ActionState } from "@/lib/action";
import { useFieldError } from "@/components/form";
import { Button, FormField, Input, Notice, Select, Sheet, Textarea, cx } from "@/components/ui";

const NETWORK_ERROR = "The request did not reach us. Check your connection and try again.";

/** Runs a server action outside a form, one at a time, and keeps its result. */
export function useRun<T = undefined>() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionState<T>>(null);
  // A ref as well as the transition flag: two clicks in the same frame both see pending === false.
  const busy = useRef(false);

  function run(action: () => Promise<ActionState<T>>, onResult?: (result: ActionState<T>) => void) {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      let result: ActionState<T>;
      try {
        result = await action();
      } catch {
        result = { ok: false, error: NETWORK_ERROR };
      }
      busy.current = false;
      setState(result);
      onResult?.(result);
    });
  }

  return { pending, state, run, reset: () => setState(null) };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * A modal question built on the native dialog element, which already traps
 * focus, closes on Escape and returns focus to the button that opened it.
 */
function ConfirmDialog({
  copy,
  pending,
  onConfirm,
  onCancel,
}: {
  copy: ConfirmCopy;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onCancel}
      className="m-auto w-[min(92vw,440px)] rounded-lg border border-rule bg-paper p-6 text-left text-ink shadow-sheet backdrop:bg-ink/40"
    >
      <h2 id={titleId} className="font-serif text-xl font-semibold">
        {copy.title}
      </h2>
      <div className="mt-2 text-sm whitespace-normal text-ink-soft">{copy.body}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending} autoFocus>
          Cancel
        </Button>
        <Button variant={copy.danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending} aria-busy={pending}>
          {pending ? "Working…" : copy.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

/**
 * A button that runs one server action. With `confirm` it asks first. It cannot
 * be pressed twice while running, and it reports the result to its parent so
 * the list it sits in can say what happened.
 */
export function ActionButton<T = undefined>({
  children,
  pendingLabel = "Working…",
  action,
  confirm,
  onResult,
  variant = "secondary",
  size = "sm",
  className,
}: {
  children: ReactNode;
  pendingLabel?: string;
  action: () => Promise<ActionState<T>>;
  confirm?: ConfirmCopy;
  onResult?: (result: ActionState<T>) => void;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
  className?: string;
}) {
  const { pending, run } = useRun<T>();
  const [asking, setAsking] = useState(false);

  function go() {
    run(action, (result) => {
      setAsking(false);
      onResult?.(result);
    });
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={pending}
        aria-busy={pending}
        onClick={() => (confirm ? setAsking(true) : go())}
      >
        {pending && !asking ? pendingLabel : children}
      </Button>
      {asking && confirm ? <ConfirmDialog copy={confirm} pending={pending} onConfirm={go} onCancel={() => setAsking(false)} /> : null}
    </>
  );
}

/** The outcome of the last row action in a list. Announced to screen readers. */
export function ResultNotice({ result, className }: { result: ActionState<unknown>; className?: string }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <Notice tone="error" className={className}>
        {result.error}
      </Notice>
    );
  }
  if (!result.message) return null;
  return (
    <Notice tone="success" className={className}>
      {result.message}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Copying links and keys
// ---------------------------------------------------------------------------

/** A value to copy by hand: a link that could not be emailed, or a key that is shown once. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  const id = useId();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      // Clipboard access can be refused (older browsers, some embedded views); selecting
      // the text leaves the person one keystroke away from copying it themselves.
      inputRef.current?.select();
      setCopied("failed");
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-[13px]"
        />
        <Button variant="secondary" onClick={copy} className="shrink-0">
          {copied === "yes" ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[13px] text-ink-soft" aria-live="polite">
        {copied === "failed" ? "Copying was blocked by your browser. The text is selected: press Ctrl or Command and C." : hint}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labelled controls for use inside ActionForm
// ---------------------------------------------------------------------------

export function SelectField({
  label,
  name,
  hint,
  optional,
  children,
  ...select
}: { label: string; name: string; hint?: ReactNode; optional?: boolean; children: ReactNode } & Omit<ComponentProps<"select">, "name" | "id">) {
  const error = useFieldError(name);
  const id = `f-${name}`;
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} optional={optional}>
      <Select id={id} name={name} aria-invalid={error ? true : undefined} {...select}>
        {children}
      </Select>
    </FormField>
  );
}

export function TextareaField({
  label,
  name,
  hint,
  optional,
  ...textarea
}: { label: string; name: string; hint?: ReactNode; optional?: boolean } & Omit<ComponentProps<"textarea">, "name" | "id">) {
  const error = useFieldError(name);
  const id = `f-${name}`;
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} optional={optional}>
      <Textarea id={id} name={name} aria-invalid={error ? true : undefined} {...textarea} />
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** One titled block of a settings page. `id` gives it a stable link target. */
export function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Sheet className={cx("scroll-mt-6 p-5 sm:p-6", className)}>
      <section aria-labelledby={id ? `${id}-title` : undefined} id={id}>
        <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="mt-1 max-w-[65ch] text-sm text-ink-soft">{description}</p> : null}
        <div className="mt-5">{children}</div>
      </section>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Forms whose result carries data
// ---------------------------------------------------------------------------

/**
 * A form for an action that hands something back to show once (an invitation
 * link, a new API key, a signing secret). ActionForm only carries a message, so
 * these keep their own state. `onData` runs once per successful result; the
 * form is cleared after it so the same thing cannot be created twice by habit.
 */
export function DataForm<T>({
  action,
  onData,
  className,
  children,
}: {
  action: (prev: ActionState<T>, form: FormData) => Promise<ActionState<T>>;
  onData: (data: T) => void;
  className?: string;
  children: (ctx: { pending: boolean; fieldError: (name: string) => string | undefined }) => ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionState<T>>(null);
  const busy = useRef(false);
  return (
    <form
      noValidate
      className={className ?? "space-y-4"}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        const form = event.currentTarget;
        const data = new FormData(form);
        startTransition(async () => {
          let result: ActionState<T>;
          try {
            result = await action(null, data);
          } catch {
            result = { ok: false, error: NETWORK_ERROR };
          }
          busy.current = false;
          setState(result);
          if (result?.ok && result.data !== undefined) {
            form.reset();
            onData(result.data);
          }
        });
      }}
    >
      {state && !state.ok ? <Notice tone="error">{state.error}</Notice> : null}
      {children({ pending, fieldError: (name) => (state && !state.ok ? state.fields?.[name] : undefined) })}
    </form>
  );
}
