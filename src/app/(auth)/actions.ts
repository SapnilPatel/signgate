"use server";

import { redirect } from "next/navigation";
import { field, runAction, type ActionState } from "@/lib/action";
import { endSession, startSession } from "@/lib/auth/session";
import { getRequestMeta } from "@/lib/request";
import { acceptInvite, logIn, requestPasswordReset, resetPassword, signUp } from "@/lib/services/accounts";

/**
 * Only same-site paths are accepted as a post-sign-in destination.
 *
 * Checked by allow-list and then by parsing, not by prefix: browsers strip tabs
 * and newlines from URLs and treat a backslash as a slash, so "/\t/other.example"
 * would otherwise become "//other.example", a link to another site.
 */
function safeNext(value: string): string {
  const fallback = "/files";
  if (value.length > 2000 || !/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(value)) return fallback;
  try {
    const base = "http://internal.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    // Dot segments are resolved by the parser; a path that resolves to a
    // double slash is refused for the same reason as one that starts with it.
    const path = url.pathname + url.search;
    return path.startsWith("//") ? fallback : path;
  } catch {
    return fallback;
  }
}

export async function signUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user } = await signUp(
      {
        orgName: field(form, "orgName"),
        name: field(form, "name"),
        email: field(form, "email"),
        password: String(form.get("password") ?? ""),
        timeZone: field(form, "timeZone"),
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
