import "server-only";
import { cache } from "react";
import { requireActor } from "@/lib/request";
import {
  getEmailSendingStatus,
  listMembers,
  resolveSettings,
  type EmailSendingStatus,
} from "@/lib/services/accounts";
import { fileCounts } from "@/lib/services/files";
import { listTemplates, resolveCountersigner } from "@/lib/services/templates";

export interface SetupStep {
  key: "agreement" | "activate" | "countersign" | "email" | "file";
  title: string;
  detail: string;
  done: boolean;
  href: string;
  action: string;
}

export interface Setup {
  steps: SetupStep[];
  doneCount: number;
  complete: boolean;
  email: EmailSendingStatus;
}

/**
 * What a new company still has to do before agreements go out on their own,
 * worked out from what is actually there. Shared by the welcome page and the
 * shell's prompt; cached so one request reads it once.
 */
export const getSetup = cache(async (): Promise<Setup> => {
  const { viewer, actor } = await requireActor();
  const [templates, members, counts, email] = await Promise.all([
    listTemplates(actor),
    listMembers(actor),
    fileCounts(actor),
    getEmailSendingStatus(actor),
  ]);
  const settings = resolveSettings(viewer.org);
  const current = templates.filter((t) => t.status !== "archived");
  const active = current.filter((t) => t.status === "active");
  const draft = current.find((t) => t.status === "draft");
  // The agreement new files will use: the default, else whichever exists.
  const main =
    active.find((t) => t.isDefault) ?? active[0] ?? current[0] ?? null;

  const steps: SetupStep[] = [
    {
      key: "agreement",
      title: "Add your agreement",
      detail:
        "Upload the agreement your clients sign: a PDF, a Word document, a photo of the pages, or pasted text.",
      done: current.length > 0,
      href: "/agreements/new",
      action: "Add your agreement",
    },
    {
      key: "activate",
      title: "Review and activate it",
      detail:
        "Check that the places to sign and fill in are where they should be, then activate the agreement so it can be sent.",
      done: active.length > 0,
      href: draft ? `/agreements/${draft.id}` : "/agreements",
      action: current.length > 0 ? "Review the agreement" : "Go to agreements",
    },
  ];

  if (main && main.fields.some((f) => f.role === "company")) {
    const { member } = resolveCountersigner(settings, members);
    const isViewer = member?.id === viewer.user.id;
    steps.push({
      key: "countersign",
      title: "Choose who countersigns and save their signature",
      detail: member
        ? member.hasSignature
          ? `${member.name} signs for your company after each client.`
          : isViewer
            ? "Your agreement has places for your company to sign, and you are the one who signs them. Save your signature once so countersigning takes a moment."
            : `Your agreement has places for your company to sign. ${member.name} signs them and has not saved a signature yet; ask them to save one in their account, or choose someone else.`
        : "Your agreement has places for your company to sign. Choose the person who signs them.",
      done: Boolean(member?.hasSignature),
      href:
        member && isViewer
          ? "/account#signature"
          : "/settings/signing#countersigning",
      action:
        member && isViewer ? "Save your signature" : "Choose the countersigner",
    });
  }

  // With no email service there is nothing to confirm: links are always shared by hand.
  if (email.emailConfigured) {
    steps.push({
      key: "email",
      title: email.viewerIsOwner
        ? "Confirm your email address"
        : "The owner confirms their email address",
      detail: email.viewerIsOwner
        ? `So agreements can be emailed for you, open the link we sent to ${viewer.user.email}. Until then you get each signing link to send yourself.`
        : "Until your company's owner opens the confirmation link we emailed them, agreements are not emailed; you get each signing link to send yourself.",
      done: email.canEmailOutside,
      href: "/settings/email",
      action: "See email status",
    });
  }

  steps.push({
    key: "file",
    title: "Create your first file",
    detail: settings.autoSendOnFileCreate
      ? "A file is one job or case for one client. Creating it sends them the agreement."
      : "A file is one job or case for one client. Create it, then send the agreement from the file.",
    done: counts.all + counts.archived > 0,
    href: "/files/new",
    action: "Create a file",
  });

  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, complete: doneCount === steps.length, email };
});
