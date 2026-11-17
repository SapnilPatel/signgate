"use server";

import { runAction, type ActionState } from "@/lib/action";
import { assertActor } from "@/lib/request";
import { resendVerification } from "@/lib/services/accounts";

export async function resendVerificationAction(): Promise<ActionState> {
  // An email that could not be sent is a failure to the person who asked for it,
  // even though the action itself ran, so it is reported through the error state.
  const outcome: { failure: string | null } = { failure: null };
  const state = await runAction<undefined>(async () => {
    const { actor, viewer } = await assertActor();
    const result = await resendVerification(actor);
    if (result.status === "sent") {
      return {
        message: `We sent a new confirmation link to ${viewer.user.email}. It works for 48 hours; earlier links no longer work.`,
      };
    }
    if (result.status === "already_verified") {
      return {
        message:
          "Your email address is already confirmed. Reload the page to see the change.",
      };
    }
    outcome.failure =
      result.status === "skipped"
        ? "Email sending is not set up on this installation, so no confirmation email can be sent."
        : `The confirmation email could not be sent. ${result.error ?? ""} Try again in a few minutes.`.replace(
            /\s+/g,
            " ",
          );
  });
  return outcome.failure ? { ok: false, error: outcome.failure } : state;
}
