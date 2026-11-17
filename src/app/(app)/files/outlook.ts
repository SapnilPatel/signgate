import "server-only";
import type { Org } from "@/lib/db/schema";
import { getEmailSendingStatus, resolveSettings } from "@/lib/services/accounts";
import type { Actor } from "@/lib/services/context";
import { listTemplates } from "@/lib/services/templates";

/**
 * What will happen if an agreement is sent right now, worked out before anyone
 * presses a button so the screens can say it up front: which agreement goes, and
 * whether it will reach the client's inbox or has to be passed on by hand.
 */
export interface SendingOutlook {
  /** The agreement a new file gets, or null when the company has none it can send. */
  agreement: { id: string; name: string } | null;
  /**
   * Every agreement that could be sent right now (in use and ready), the default first.
   * Empty when sending is blocked. The screens offer a choice only when there is more than one.
   */
  choices: { id: string; name: string }[];
  /** Why nothing can be sent at all, in words to show as they are; null when sending works. */
  blocked: string | null;
  /** True when the fix for `blocked` is to set up an agreement, so the screen links there. */
  needsAgreement: boolean;
  /** "ok": emails go out. Otherwise a link is still created and has to be shared by hand. */
  email: "ok" | "not_configured" | "unverified";
  /** Present when email is "unverified": the sentence that explains the hold. */
  emailReason: string | null;
  /** The company's setting: send as soon as a file is created. */
  autoSend: boolean;
}

export async function getSendingOutlook(actor: Actor, org: Org): Promise<SendingOutlook> {
  const [templates, email] = await Promise.all([listTemplates(actor), getEmailSendingStatus(actor)]);
  // The same choice sending makes: the default if it is active, or the only active agreement.
  const active = templates.filter((t) => t.status === "active");
  const chosen = active.find((t) => t.isDefault) ?? (active.length === 1 ? active[0] : undefined);

  let blocked: string | null = null;
  let needsAgreement = false;
  if (!chosen) {
    needsAgreement = true;
    blocked =
      active.length === 0
        ? "Your company has no active agreement yet, so nothing can be sent for signature."
        : "Your company has more than one active agreement and none is the default, so nothing is sent automatically.";
  } else if (!chosen.readiness.ready) {
    blocked = chosen.readiness.problems[0]?.message ?? `"${chosen.name}" is not ready to send.`;
  }

  const choices =
    chosen && !blocked
      ? [chosen, ...active.filter((t) => t.id !== chosen.id && t.readiness.ready).sort((a, b) => a.name.localeCompare(b.name))].map((t) => ({ id: t.id, name: t.name }))
      : [];

  return {
    agreement: chosen && !blocked ? { id: chosen.id, name: chosen.name } : null,
    choices,
    blocked,
    needsAgreement,
    email: !email.emailConfigured ? "not_configured" : email.canEmailOutside ? "ok" : "unverified",
    emailReason: email.reason,
    autoSend: resolveSettings(org).autoSendOnFileCreate !== false,
  };
}
