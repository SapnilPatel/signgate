"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { field, runAction, type ActionState } from "@/lib/action";
import { assertActor, getRequestMeta } from "@/lib/request";
import { ServiceError } from "@/lib/services/context";
import {
  getSigningLink,
  resendToSigner,
  retryFinalize,
  sendAgreementForFile,
  sendReminderNow,
  updateSigner,
  voidEnvelope,
} from "@/lib/services/envelopes";
import { archiveFile, createFile, unarchiveFile, updateFile } from "@/lib/services/files";
import type { AgreementOutcome, CreateFileOutcome, UpdateFileOutcome } from "./action-types";

/** An agreement id from a form or a client component: a short string, or nothing (the company default). */
const chosenAgreement = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined);

const NOT_EMAILED = "The agreement is ready to sign, but it was not emailed.";

/** A sentence for a request that went out, or did not, and the link when it has to be shared by hand. */
function delivered(result: { delivery: string; deliveryReason?: string; signingUrl: string | null }, emailed: string): AgreementOutcome {
  if (result.delivery === "emailed") return { message: emailed, tone: "success", signingUrl: result.signingUrl };
  return {
    message: `${NOT_EMAILED} ${result.deliveryReason ?? "Copy the signing link and send it yourself."}`,
    tone: "warning",
    signingUrl: result.signingUrl,
  };
}

// ---------------------------------------------------------------------------
// Creating and editing files
// ---------------------------------------------------------------------------

export async function createFileAction(_prev: ActionState<CreateFileOutcome>, form: FormData): Promise<ActionState<CreateFileOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const meta = await getRequestMeta();
    // Always explicit, so what the form said is what happens whatever the company default is.
    const send = form.get("skipSend") !== "on";
    // Present when the form offered a choice of agreement.
    const templateId = send ? chosenAgreement(form.get("templateId")) : undefined;
    const result = await createFile(
      actor,
      {
        clientName: field(form, "clientName"),
        clientEmail: field(form, "clientEmail"),
        clientCompany: field(form, "clientCompany"),
        clientTitle: field(form, "clientTitle"),
        clientPhone: field(form, "clientPhone"),
        description: field(form, "description"),
        reference: field(form, "reference"),
        // Creating a file can only send the default agreement, so a chosen one is sent as a second step.
        send: send && !templateId,
      },
      meta,
    );
    if (templateId && result.created) {
      // The file exists now. Like createFile itself, a problem with the agreement is reported, never thrown.
      try {
        const sent = await sendAgreementForFile(actor, result.file.id, { templateId }, meta);
        result.agreement = { sent: true, envelopeId: sent.envelopeId, delivery: sent.delivery, deliveryReason: sent.deliveryReason, signingUrl: sent.signingUrl };
      } catch (err) {
        if (!(err instanceof ServiceError)) console.error("[files] sending the chosen agreement failed", err instanceof Error ? err.message : String(err));
        result.agreement = {
          sent: false,
          reason: err instanceof ServiceError ? err.message : "The file was created, but the agreement could not be sent just now. Open the file and send it from there.",
        };
      }
    }
    const { agreement } = result;
    return {
      data: {
        fileId: result.file.id,
        reference: result.file.reference,
        clientName: result.file.clientName,
        clientEmail: result.file.clientEmail,
        created: result.created,
        agreement: {
          sent: agreement.sent,
          emailed: agreement.sent && agreement.delivery === "emailed",
          reason: agreement.sent ? (agreement.deliveryReason ?? null) : (agreement.reason ?? null),
          signingUrl: agreement.signingUrl ?? null,
        },
      },
    };
  });
}

export async function updateFileAction(_prev: ActionState<UpdateFileOutcome>, form: FormData): Promise<ActionState<UpdateFileOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const id = field(form, "id");
    const result = await updateFile(
      actor,
      id,
      {
        clientName: field(form, "clientName"),
        clientEmail: field(form, "clientEmail"),
        clientCompany: field(form, "clientCompany"),
        clientTitle: field(form, "clientTitle"),
        clientPhone: field(form, "clientPhone"),
        description: field(form, "description"),
        reference: field(form, "reference"),
      },
      await getRequestMeta(),
    );
    const signerId = result.outstandingEnvelope?.clientSignerId;
    if (result.reissueSuggested && signerId) {
      // The link already with the client still carries the old details; the form asks what to do about it.
      return { data: { reissue: { signerId, name: result.file.clientName, email: result.file.clientEmail } } };
    }
    redirect(`/files/${result.file.id}?saved=1`);
  });
}

export async function archiveFileAction(fileId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await archiveFile(actor, fileId, await getRequestMeta());
    refresh();
    const voided = result.voided > 0 ? " The agreement that was out for signature was voided, so its link no longer works." : "";
    return { data: { message: `This file is archived.${voided}`, tone: "success" as const } };
  });
}

export async function restoreFileAction(fileId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    await unarchiveFile(actor, fileId, await getRequestMeta());
    refresh();
    return { data: { message: "This file is back in your working list.", tone: "success" as const } };
  });
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

export interface SendChoices {
  /** The agreement to send, when the sender picked one; otherwise the company default. */
  templateId?: string;
  /** Void what is out (or supersede what is closed) and send the current agreement. */
  replace?: boolean;
  /** The envelope the sender was looking at, so a repeated click returns the first replacement. */
  replaceEnvelopeId?: string;
  /** Only ever set after the sender confirmed discarding an agreement the client has signed. */
  replaceSigned?: boolean;
}

export async function sendAgreementAction(fileId: string, choices: SendChoices = {}): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await sendAgreementForFile(
      actor,
      fileId,
      {
        templateId: chosenAgreement(choices?.templateId),
        replace: choices?.replace === true,
        replaceEnvelopeId: typeof choices?.replaceEnvelopeId === "string" ? choices.replaceEnvelopeId : undefined,
        replaceSigned: choices?.replaceSigned === true,
      },
      await getRequestMeta(),
    );
    refresh();
    if (result.duplicate) {
      return { data: { message: "This agreement had already been sent a moment ago, so nothing new went out.", tone: "success" as const, signingUrl: result.signingUrl } };
    }
    return { data: delivered(result, "The agreement was emailed to the client.") };
  });
}

export async function resendAction(signerId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await resendToSigner(actor, signerId, await getRequestMeta());
    refresh();
    return { data: delivered(result, "The signing request was emailed again.") };
  });
}

export async function remindAction(envelopeId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await sendReminderNow(actor, envelopeId, await getRequestMeta());
    refresh();
    return { data: delivered(result, `A reminder was emailed to ${result.to}.`) };
  });
}

export async function correctSignerAction(signerId: string, name: string, email: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await updateSigner(actor, signerId, { name, email }, await getRequestMeta());
    refresh();
    if (result.delivery === "not_their_turn") {
      return { data: { message: `The details were corrected. ${result.signer.name} is emailed a new link when it is their turn.`, tone: "success" as const, signingUrl: result.signingUrl } };
    }
    return {
      data: delivered(
        { delivery: result.delivery, deliveryReason: result.deliveryReason, signingUrl: result.signingUrl },
        `The details were corrected and a new signing link was emailed to ${result.signer.email}. The old link no longer works.`,
      ),
    };
  });
}

/** `includeSigned` is only ever set after the sender confirmed discarding the client's signature. */
export async function voidAction(envelopeId: string, reason: string, includeSigned = false): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await voidEnvelope(actor, envelopeId, reason, await getRequestMeta(), { includeSigned: includeSigned === true });
    refresh();
    return {
      data: {
        message: result.alreadyVoided ? "This agreement had already been voided." : "The agreement was voided. Its signing links no longer work.",
        tone: "success" as const,
      },
    };
  });
}

export async function retryFinalCopyAction(envelopeId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await retryFinalize(actor, envelopeId);
    refresh();
    if (result.status === "completed") return { data: { message: "The final signed copy is ready to download.", tone: "success" as const } };
    const cause = result.status === "failed" ? result.error : result.reason;
    throw new ServiceError("conflict", `The final copy still could not be produced: ${cause.replace(/[.\s]+$/, "")}. Nothing is lost: the signatures are saved and it is retried automatically.`);
  });
}

/** A fresh link for a signer whose link is not on the page (the server secret changed since it was issued). */
export async function signingLinkAction(signerId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { signingUrl, signer } = await getSigningLink(actor, signerId, await getRequestMeta());
    return { data: { message: `This is ${signer.name}'s signing link.`, tone: "success" as const, signingUrl } };
  });
}

/** Takes the countersigner to the signing page for the company's side. */
export async function countersignAction(signerId: string): Promise<ActionState<AgreementOutcome>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { signingUrl } = await getSigningLink(actor, signerId, await getRequestMeta());
    redirect(signingUrl);
  });
}
