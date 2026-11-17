"use server";

/**
 * Server actions behind the settings screens. Each one is a thin call into a
 * service, which does its own permission check against the stored row; nothing
 * here decides who may do what.
 */
import { revalidatePath } from "next/cache";
import { field, runAction, type ActionState } from "@/lib/action";
import { assertActor, getRequestMeta } from "@/lib/request";
import {
  changeMemberRole,
  inviteMember,
  revokeInvite,
  setMemberDisabled,
  transferOwnership,
  updateOrg,
} from "@/lib/services/accounts";
import { ServiceError } from "@/lib/services/context";
import { createApiKey, revokeApiKey } from "@/lib/services/api-keys";
import { createWebhook, deleteWebhook, sendTestEvent, setWebhookActive } from "@/lib/services/webhooks";

/** The shell shows the company name and the set-up prompt, so every change re-renders from the layout down. */
function refresh(): void {
  revalidatePath("/", "layout");
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Company and branding
// ---------------------------------------------------------------------------

export async function saveCompanyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await updateOrg(
      actor,
      {
        name: field(form, "name"),
        legalName: field(form, "legalName"),
        settings: { timeZone: field(form, "timeZone"), fileReferencePrefix: field(form, "fileReferencePrefix") },
      },
      await getRequestMeta(),
    );
    refresh();
    return { message: "Company details saved." };
  });
}

export async function saveBrandColorAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await updateOrg(actor, { settings: { brandColor: field(form, "brandColor") } }, await getRequestMeta());
    refresh();
    return { message: "Brand colour saved. New emails and signing pages use it from now on." };
  });
}

export async function saveLogoAction(dataUrl: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    if (typeof dataUrl !== "string" || !dataUrl) {
      // An empty value would mean "remove the logo" to the service; uploading nothing must not do that.
      throw new ServiceError("invalid", "Choose a PNG or JPEG image to upload.");
    }
    await updateOrg(actor, { settings: { logo: dataUrl } }, await getRequestMeta());
    refresh();
    return { message: "Logo saved." };
  });
}

export async function removeLogoAction(): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await updateOrg(actor, { settings: { logo: null } }, await getRequestMeta());
    refresh();
    return { message: "Logo removed. Your company name is shown instead." };
  });
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export async function saveSendingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await updateOrg(
      actor,
      {
        settings: {
          // An unticked checkbox is simply absent from the form.
          autoSendOnFileCreate: form.get("autoSendOnFileCreate") === "on",
          reminderEveryDays: field(form, "reminderEveryDays"),
          maxReminders: field(form, "maxReminders"),
          expireAfterDays: field(form, "expireAfterDays"),
          emailMessage: String(form.get("emailMessage") ?? ""),
          replyToEmail: field(form, "replyToEmail"),
        },
      },
      await getRequestMeta(),
    );
    refresh();
    return { message: "Saved. Agreements sent from now on follow these settings." };
  });
}

export async function saveCountersigningAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const mode = field(form, "countersignMode");
    await updateOrg(
      actor,
      { settings: { countersignerUserId: field(form, "countersignerUserId"), countersignMode: mode } },
      await getRequestMeta(),
    );
    refresh();
    return {
      message:
        mode === "auto"
          ? "Saved. The countersigner's saved signature is applied as soon as a client signs."
          : "Saved. The countersigner is emailed to sign each agreement after the client.",
    };
  });
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface InviteOutcome {
  email: string;
  url: string;
  emailed: boolean;
  /** Why the invitation was not emailed, when it was not. */
  reason: string | null;
}

export async function inviteAction(_prev: ActionState<InviteOutcome>, form: FormData): Promise<ActionState<InviteOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await inviteMember(actor, { email: field(form, "email"), role: field(form, "role") }, await getRequestMeta());
    refresh();
    const emailed = result.emailStatus === "sent";
    return {
      data: {
        email: result.invite.email,
        url: result.url,
        emailed,
        reason: emailed
          ? null
          : (result.emailError ??
            (result.emailStatus === "skipped"
              ? "Email sending is not set up, so the invitation was not emailed."
              : "The invitation email could not be sent.")),
      },
    };
  });
}

export async function revokeInviteAction(inviteId: string, email: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await revokeInvite(actor, inviteId, await getRequestMeta());
    refresh();
    return { message: `The invitation to ${email} is cancelled. Its link no longer works.` };
  });
}

const ROLE_NAME = { owner: "an owner", admin: "an admin", member: "a member" } as const;

export async function changeRoleAction(userId: string, role: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const changed = await changeMemberRole(actor, userId, role, await getRequestMeta());
    refresh();
    const cancelled =
      changed.cancelledInvites.length > 0
        ? ` Invitations they had sent were cancelled: ${list(changed.cancelledInvites)}.`
        : "";
    return { message: `${changed.name} is now ${ROLE_NAME[changed.role]}.${cancelled}` };
  });
}

export async function setDisabledAction(userId: string, disabled: boolean): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const changed = await setMemberDisabled(actor, userId, disabled, await getRequestMeta());
    refresh();
    if (!disabled) return { message: `${changed.name} can sign in again. API keys and invitations that were cancelled stay cancelled.` };
    const parts = [`${changed.name} can no longer sign in, and any countersigning links in their inbox have stopped working.`];
    if (changed.revokedApiKeys.length > 0) {
      parts.push(
        `API keys they created were revoked: ${list(changed.revokedApiKeys.map((k) => k.name))}. Anything using ${changed.revokedApiKeys.length === 1 ? "that key" : "those keys"} needs a new one.`,
      );
    }
    if (changed.cancelledInvites.length > 0) {
      parts.push(`Invitations they had sent were cancelled: ${list(changed.cancelledInvites)}.`);
    }
    return { message: parts.join(" ") };
  });
}

export async function transferOwnershipAction(userId: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { newOwner } = await transferOwnership(actor, userId, await getRequestMeta());
    refresh();
    return { message: `${newOwner.name} is now the owner. You are an admin.` };
  });
}

// ---------------------------------------------------------------------------
// Developers
// ---------------------------------------------------------------------------

export interface NewApiKey {
  name: string;
  key: string;
}

export async function createApiKeyAction(_prev: ActionState<NewApiKey>, form: FormData): Promise<ActionState<NewApiKey>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { key, row } = await createApiKey(actor, field(form, "name"));
    refresh();
    return { data: { name: row.name, key } };
  });
}

export async function revokeApiKeyAction(id: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const row = await revokeApiKey(actor, id);
    refresh();
    return { message: `The key "${row.name}" is revoked. Requests that use it are now refused.` };
  });
}

export interface NewWebhook {
  url: string;
  secret: string;
}

export async function createWebhookAction(_prev: ActionState<NewWebhook>, form: FormData): Promise<ActionState<NewWebhook>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const row = await createWebhook(actor, field(form, "url"));
    refresh();
    return { data: { url: row.url, secret: row.secret } };
  });
}

export async function setWebhookActiveAction(id: string, active: boolean): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await setWebhookActive(actor, id, active);
    refresh();
    return { message: active ? "The endpoint is on again and will receive new events." : "The endpoint is paused. It receives no events until you turn it back on." };
  });
}

export async function deleteWebhookAction(id: string): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await deleteWebhook(actor, id);
    refresh();
    return { message: "The endpoint and its delivery history were removed." };
  });
}

export async function sendTestEventAction(id: string): Promise<ActionState> {
  // The action itself worked when the endpoint refuses the event, but the person
  // needs to see it as a failure, so it is reported through the error state.
  const outcome: { failure: string | null } = { failure: null };
  const state = await runAction<undefined>(async () => {
    const { actor } = await assertActor();
    const result = await sendTestEvent(actor, id);
    refresh();
    if (result.ok) return { message: `The test event was delivered. Your endpoint answered with status ${result.status}.` };
    const reason = result.error ?? "The endpoint did not accept the event.";
    outcome.failure = `The test event was not delivered. ${reason}`;
  });
  return outcome.failure ? { ok: false, error: outcome.failure } : state;
}
