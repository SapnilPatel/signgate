"use server";

import { redirect } from "next/navigation";
import { field, runAction, type ActionState } from "@/lib/action";
import { endSession, startSession } from "@/lib/auth/session";
import { getRequestMeta } from "@/lib/request";
import { acceptInvite, logIn, requestPasswordReset, resetPassword, signUp } from "@/lib/services/accounts";

/** Only same-site paths are accepted as a post-sign-in destination. */
function safeNext(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/files";
}

export async function signUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user } = await signUp(
      {
        orgName: field(form, "orgName"),
        name: field(form, "name"),
        email: field(form, "email"),
        password: String(form.get("password") ?? ""),
      },
      await getRequestMeta(),
    );
    await startSession(user.id);
    redirect("/welcome");
  });
}

export async function logInAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await logIn(
      { email: field(form, "email"), password: String(form.get("password") ?? "") },
      await getRequestMeta(),
    );
    await startSession(user.id);
    redirect(safeNext(field(form, "next")));
  });
}

export async function logOutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function forgotPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await requestPasswordReset(field(form, "email"), await getRequestMeta());
    // Same answer whether or not the account exists, so this form cannot be used to discover accounts.
    return { message: "If an account exists for that email, a reset link is on its way. It works for one hour." };
  });
}

export async function resetPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await resetPassword(field(form, "token"), String(form.get("password") ?? ""), await getRequestMeta());
    await startSession(user.id);
    redirect("/files");
  });
}

export async function acceptInviteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user } = await acceptInvite(
      field(form, "token"),
      { name: field(form, "name"), password: String(form.get("password") ?? "") },
      await getRequestMeta(),
    );
    await startSession(user.id);
    redirect("/files");
  });
}
