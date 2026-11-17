"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A modal built on the native <dialog>: the browser traps focus, closes on Escape
 * and returns focus to whatever opened it. On a phone it is a sheet: at the bottom
 * for drawing (thumbs reach it), at the top for typing (the on-screen keyboard
 * covers the bottom half of the screen).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  anchor = "bottom",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  anchor?: "bottom" | "top";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // The page behind must not scroll while a finger is drawing or the sheet is being scrolled.
  useEffect(() => {
    if (!open) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cx(
        "max-h-none w-full max-w-full overflow-visible bg-transparent p-0 text-ink backdrop:bg-ink/45 sm:m-auto sm:max-w-[560px]",
        anchor === "bottom" ? "mx-0 mt-auto mb-0" : "mx-0 mt-0 mb-auto",
      )}
    >
      {open ? (
        <div
          className={cx(
            "flex max-h-[94dvh] flex-col border border-rule bg-paper shadow-sheet sm:max-h-[88dvh] sm:rounded-lg",
            anchor === "bottom" ? "rounded-t-xl" : "rounded-b-xl",
          )}
        >
          <div className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-6 sm:pt-5">
            <div className="min-w-0">
              <h2 id={`${id}-title`} className="font-serif text-xl leading-tight font-semibold text-ink [overflow-wrap:anywhere]">
                {title}
              </h2>
              {description ? (
                <p id={`${id}-desc`} className="mt-1 text-sm text-ink-soft">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 -mt-1 h-10 shrink-0 rounded-md px-3 text-sm font-semibold text-ink-soft hover:bg-rule-soft hover:text-ink"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">{children}</div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule-soft px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
