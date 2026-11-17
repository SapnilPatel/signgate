"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";
import type { ActionState } from "@/lib/action";
import { Button, Notice } from "@/components/ui";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

const FormContext = createContext<{ state: ActionState; pending: boolean }>({ state: null, pending: false });

/** The enclosing ActionForm's latest result and whether it is running. */
export function useFormState() {
  return useContext(FormContext);
}

/**
 * A form bound to a server action. Shows the form-level error or success message
 * above its children. Submitting through onSubmit (rather than letting React
 * dispatch the action itself) keeps what the person typed when the action
 * returns an error; without JavaScript the plain form action still works.
 */
export function ActionForm({ action, children, className }: { action: Action; children: ReactNode; className?: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // After a failed submit the browser leaves focus on nothing; a keyboard user would
  // start again from the top of the page. Put them on the first field to correct, or
  // on the message when no single field is at fault.
  useEffect(() => {
    if (!state || state.ok) return;
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
    (invalid ?? errorRef.current)?.focus();
  }, [state]);
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        startTransition(() => formAction(data));
      }}
      className={className ?? "space-y-4"}
      noValidate
    >
      {state && !state.ok ? (
        <div ref={errorRef} tabIndex={-1} className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-note/40">
          <Notice tone="error">{state.error}</Notice>
        </div>
      ) : null}
      {state && state.ok && state.message ? <Notice tone="success">{state.message}</Notice> : null}
      <FormContext.Provider value={{ state, pending }}>{children}</FormContext.Provider>
    </form>
  );
}

/** Submit button that disables itself and says what is happening while the action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { pending } = useFormState();
  return (
    <Button type="submit" variant={variant} size={size} className={className} disabled={pending} aria-busy={pending}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </Button>
  );
}

/** Field-level error for a named input from the enclosing form's last result. */
export function useFieldError(name: string): string | undefined {
  const { state } = useFormState();
  return state && !state.ok ? state.fields?.[name] : undefined;
}
