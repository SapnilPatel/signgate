"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui";

/**
 * Asks before something that cannot be taken back with Undo. Built on the browser's
 * own dialog, which traps focus, closes on Escape and returns focus to the button
 * that opened it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="m-auto w-[min(92vw,30rem)] rounded-lg border border-rule bg-paper p-0 text-ink shadow-sheet backdrop:bg-ink/40"
      onCancel={(event) => {
        // Escape while the action is running would hide a result the person needs to see.
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        if (open && !busy) onCancel();
      }}
    >
      <div className="p-5 sm:p-6">
        <h2 id={`${id}-title`} className="font-serif text-xl font-semibold">
          {title}
        </h2>
        <div id={`${id}-body`} className="mt-2 space-y-2 text-sm text-ink-soft">
          {children}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? (busyLabel ?? "Working…") : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
