"use client";

import type { ActionState } from "@/lib/action";
import { Button } from "@/components/ui";
import { useRun } from "../settings/parts";
import { resendVerificationAction } from "./actions";

/** Sends the signed-in person a fresh confirmation link and says what happened, in place. */
export function ResendVerificationButton({
  email,
  compact = false,
}: {
  email: string;
  compact?: boolean;
}) {
  const { pending, state, run } = useRun();
  const result: ActionState = state;
  return (
    <span
      className={
        compact
          ? "inline-flex flex-wrap items-center gap-x-3 gap-y-1"
          : "flex flex-wrap items-center gap-x-3 gap-y-2"
      }
    >
      <Button
        variant="secondary"
        size={compact ? "sm" : "md"}
        disabled={pending}
        aria-busy={pending}
        onClick={() => run(resendVerificationAction)}
        title={`Send a new confirmation link to ${email}`}
      >
        {pending ? "Sending…" : "Resend the email"}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={
          result && !result.ok
            ? "text-[13px] text-stop"
            : "text-[13px] text-ink-soft"
        }
      >
        {result ? (result.ok ? result.message : result.error) : null}
      </span>
    </span>
  );
}
