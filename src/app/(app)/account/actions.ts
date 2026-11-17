"use server";

import { revalidatePath } from "next/cache";
import { field, runAction, type ActionState } from "@/lib/action";
import { startSession } from "@/lib/auth/session";
import { assertActor, getRequestMeta } from "@/lib/request";
import {
  changePassword,
  clearSignature,
  saveSignature,
  updateProfile,
} from "@/lib/services/accounts";

/** The shell shows the person's name, and the set-up checklist depends on the saved signature. */
function refresh(): void {
  revalidatePath("/", "layout");
}

export async function saveProfileAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await updateProfile(actor, {
      name: field(form, "name"),
      title: field(form, "title"),
    });
    refresh();
    return { message: "Your details are saved." };
  });
}

export async function changePasswordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    // Passwords are taken exactly as typed: a leading or trailing space may be part of one.
    const member = await changePassword(
      actor,
      String(form.get("current") ?? ""),
      String(form.get("next") ?? ""),
      await getRequestMeta(),
    );
    // The service signs this person out everywhere, this browser included; signing
    // this one back in leaves every other device signed out.
    await startSession(member.id);
    return {
      message:
        "Your password is changed. Every other device that was signed in as you has been signed out.",
    };
  });
}

export async function saveSignatureAction(
  dataUrl: string,
): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await saveSignature(actor, dataUrl);
    refresh();
    return { message: "Your signature is saved." };
  });
}

export async function clearSignatureAction(): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await clearSignature(actor);
    refresh();
    return {
      message:
        "Your saved signature is removed. If you countersign agreements, you will be emailed to sign each one yourself.",
    };
  });
}
