import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { resolveSettings } from "@/lib/services/accounts";
import { ServiceError, type Actor } from "@/lib/services/context";
import type { DescribedEvent, SignerView } from "@/lib/services/envelopes";
import { getFile, type FileEnvelope } from "@/lib/services/files";
import { orgTimeZone } from "@/lib/services/signing";
import { ButtonLink, Notice, PageHeader, SectionTitle, Sheet, StatusBadge, cx, formatDate } from "@/components/ui";
import { onComingDay, onPastDay, pastDay, shortDate } from "../format";
import { getSendingOutlook } from "../outlook";
import { AgreementPanel, FileArchiveButton, type PanelModel } from "./agreement-panel";

/** One lookup shared by the page and its title. */
const loadFile = cache(async (actor: Actor, id: string) => {
  try {
    return await getFile(actor, id);
  } catch (err) {
    // Another company's file and a mistyped address look the same on purpose.
    if (err instanceof ServiceError && (err.code === "not_found" || err.code === "invalid")) return null;
    throw err;
  }
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [{ id }, { actor }] = await Promise.all([params, requireActor()]);
  const detail = await loadFile(actor, id);
  return { title: detail ? `${detail.file.clientName}, ${detail.file.reference}` : "File not found" };
}

const AWAITING_CLIENT = ["draft", "sent", "viewed"];
const OPEN = [...AWAITING_CLIENT, "client_signed"];

const documentHref = (envelopeId: string, kind: "original" | "in_progress" | "signed", download = false) =>
  `/api/app/envelopes/${envelopeId}/document?kind=${kind}${download ? "&download=1" : ""}`;

/** Emails that reached someone; a failure older than the latest of these is no longer a problem to show. */
function isDelivered(event: DescribedEvent): boolean {
  if (event.type === "reminder.sent" || event.type === "countersign.requested") return true;
  if (event.type !== "envelope.sent") return false;
  const data = (event.data ?? {}) as Record<string, unknown>;
  return data.channel !== "link" && data.delivery !== "link";
}

interface Standing {
  /** One sentence anyone in the office understands. */
  headline: string;
  /** What happens next by itself, or what the reader should do. */
  detail: string[];
}

function standingOf(input: {
  envelope: FileEnvelope | null;
  events: DescribedEvent[];
  orgName: string;
  archived: boolean;
  maxReminders: number;
  now: Date;
  timeZone: string;
  clientNameOnFile: string;
  /** The account has no way to send email at all. */
  emailOff: boolean;
}): Standing {
  const { envelope, events, orgName, now, timeZone } = input;
  if (!envelope) {
    return {
      headline: "No agreement has been sent for this file.",
      detail: input.archived ? [] : ["Work should not start until the client has signed."],
    };
  }
  const client = envelope.signers.find((s) => s.role === "client");
  const company = envelope.signers.find((s) => s.role === "company");
  const clientName = client?.name ?? input.clientNameOnFile;
  const when = (type: string, fallback: Date) => [...events].reverse().find((e) => e.envelopeId === envelope.id && e.type === type)?.createdAt ?? fallback;
  const quoted = (reason: string | null) => (reason ? reason.replace(/\s+/g, " ").trim() : "");

  switch (envelope.status) {
    case "completed":
      return {
        headline: `Signed by everyone ${onPastDay(envelope.completedAt ?? envelope.updatedAt, now, timeZone)}.`,
        detail: ["This file is cleared to start. The signed copy, with its audit certificate, is below."],
      };
    case "declined": {
      const reason = quoted(envelope.declineReason);
      return {
        headline: `${clientName} declined to sign ${onPastDay(when("envelope.declined", envelope.updatedAt), now, timeZone)}.`,
        detail: [reason ? `Their reason: "${reason}"` : "They did not give a reason.", "Once it is sorted out with them, send the agreement again."],
      };
    }
    case "voided": {
      const reason = quoted(envelope.voidReason);
      return {
        headline: `The agreement was voided ${onPastDay(when("envelope.voided", envelope.updatedAt), now, timeZone)}, so its signing link no longer works.`,
        detail: [reason ? `Reason given: "${reason}"` : "", "Send it again if a signature is still needed."].filter(Boolean),
      };
    }
    case "expired":
      return {
        headline: `The signing request expired ${onPastDay(envelope.expiresAt ?? envelope.updatedAt, now, timeZone)} without being signed.`,
        detail: ["Send the agreement again to give the client a new link."],
      };
    case "client_signed": {
      const signedOn = client?.signedAt ? ` ${onPastDay(client.signedAt, now, timeZone)}` : "";
      if (!company || company.status === "signed") {
        const failed = [...events].reverse().find((e) => e.envelopeId === envelope.id && e.type === "envelope.finalize_failed");
        return {
          headline: "Everyone has signed. The final signed copy is being produced.",
          detail: failed
            ? [`The last attempt did not work (${formatDate(failed.createdAt, { time: true, timeZone })}). ${failed.description}.`, "Nothing is lost: the signatures are saved. You can also retry now."]
            : ["This usually takes a few seconds. Reload the page to see it."],
        };
      }
      return {
        headline: envelope.canCountersign
          ? `${clientName} signed${signedOn}. It is now waiting for your signature on behalf of ${orgName}.`
          : `${clientName} signed${signedOn}. It is now waiting for ${company.name} to sign for ${orgName}.`,
        detail: envelope.canCountersign ? ["Read what the client signed, then sign for the company to finish."] : [`Only ${company.name}, an owner or an admin can sign for the company.`],
      };
    }
    default: {
      // draft, sent or viewed: the client has the next move.
      if (envelope.expiresAt && envelope.expiresAt.getTime() <= now.getTime()) {
        return {
          headline: `The signing request expired ${onPastDay(envelope.expiresAt, now, timeZone)} without being signed.`,
          detail: ["Send a fresh copy to give the client a new link."],
        };
      }
      if (envelope.status === "draft") {
        return {
          headline: `The agreement is ready for ${clientName} to sign, but the request has not reached them by email.`,
          detail: [input.emailOff ? "Email is not set up for this account, so nothing is emailed to clients. Copy the signing link and send it to them yourself." : "Copy the signing link and send it to them yourself, or email the request again."],
        };
      }
      const detail: string[] = [client?.viewedAt ? `They opened it ${onPastDay(client.viewedAt, now, timeZone)} but have not signed yet.` : "They have not opened it yet."];
      if (envelope.nextReminderAt && envelope.reminderCount < input.maxReminders) {
        detail.push(`Reminder ${envelope.reminderCount + 1} of ${input.maxReminders} goes out ${onComingDay(envelope.nextReminderAt, now, timeZone)}.`);
      } else if (input.maxReminders > 0 && envelope.reminderCount >= input.maxReminders) {
        detail.push(`All ${input.maxReminders} automatic reminders have gone out. Send one yourself, or call the client.`);
      } else {
        detail.push("No automatic reminder is scheduled.");
      }
      if (envelope.expiresAt) detail.push(`The link stops working ${onComingDay(envelope.expiresAt, now, timeZone)}.`);
      return { headline: `Waiting on ${clientName} since ${pastDay(envelope.sentAt ?? envelope.createdAt, now, timeZone)}.`, detail };
    }
  }
}

function signerStanding(signer: SignerView, envelope: FileEnvelope, now: Date, timeZone: string): string {
  if (signer.status === "signed") return signer.signedAt ? `Signed ${onPastDay(signer.signedAt, now, timeZone)}` : "Signed";
  if (signer.status === "declined") return "Declined to sign";
  if (!OPEN.includes(envelope.status)) return "Did not sign";
  if (signer.role === "company" && envelope.status !== "client_signed") return "Signs after the client";
  if (signer.viewedAt) return `Opened ${onPastDay(signer.viewedAt, now, timeZone)}, not signed yet`;
  if (envelope.status === "draft") return "Not emailed yet";
  return signer.role === "company" ? "Has not signed yet" : "Not opened yet";
}

const CLOSED_LABEL: Record<string, string> = { completed: "Signed", declined: "Declined", voided: "Voided", expired: "Expired" };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5">
      <dt className="text-[13px] leading-[22px] text-ink-soft">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function TimelineEntry({ event, timeZone }: { event: DescribedEvent; timeZone: string }) {
  return (
    <li className="grid gap-x-4 gap-y-0.5 border-b border-rule-soft py-2.5 last:border-b-0 sm:grid-cols-[11.5rem_1fr]">
      <time dateTime={event.createdAt.toISOString()} className="tabular text-[13px] leading-[22px] text-ink-soft">
        {formatDate(event.createdAt, { time: true, timeZone })}
      </time>
      <span className="min-w-0 break-words">{event.description}</span>
    </li>
  );
}

export default async function FilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { viewer, actor } = await requireActor();

  const detail = await loadFile(actor, id);
  if (!detail) notFound();
  const { file, envelopes, events } = detail;
  const outlook = await getSendingOutlook(actor, viewer.org);
  const settings = resolveSettings(viewer.org);
  const timeZone = orgTimeZone(viewer.org) ?? "UTC";
  const now = new Date();
  const manager = canManage(viewer.user);
  const archived = Boolean(file.archivedAt);

  // The service keeps at most one agreement open per file; everything else is history.
  const current = envelopes.find((e) => OPEN.includes(e.status)) ?? envelopes[0] ?? null;
  const earlier = envelopes.filter((e) => e.id !== current?.id);
  const isOpen = current !== null && OPEN.includes(current.status);
  const client = current?.signers.find((s) => s.role === "client") ?? null;
  const company = current?.signers.find((s) => s.role === "company") ?? null;
  const lapsed = isOpen && AWAITING_CLIENT.includes(current.status) && current.expiresAt !== null && current.expiresAt.getTime() <= now.getTime();
  const sealing = isOpen && current.status === "client_signed" && (!company || company.status === "signed");

  const standing = standingOf({
    envelope: current,
    events,
    orgName: viewer.org.name,
    archived,
    maxReminders: settings.maxReminders,
    now,
    timeZone,
    clientNameOnFile: file.clientName,
    emailOff: outlook.email === "not_configured",
  });

  const lastDelivered = isOpen ? [...events].reverse().find((e) => e.envelopeId === current.id && isDelivered(e)) : undefined;
  const emailProblems = isOpen
    ? events
        .filter((e) => e.envelopeId === current.id && e.type === "envelope.delivery_failed" && (!lastDelivered || e.createdAt.getTime() > lastDelivered.createdAt.getTime()))
        .slice(-3)
        .reverse()
    : [];

  // With no email provider every request "fails" the same way; say that once instead of listing each attempt.
  const emailOff = outlook.email === "not_configured";

  const documents: PanelModel["documents"] = [];
  if (current) {
    if (current.status === "completed" && current.finalBlobId) {
      documents.push({ label: "Download the signed PDF", href: documentHref(current.id, "signed", true), primary: true });
    }
    if (current.status === "client_signed") {
      documents.push({ label: "View it with the signatures so far", href: documentHref(current.id, "in_progress") });
    }
    documents.push({ label: current.status === "completed" ? "Download the original, unsigned" : "View the agreement as sent", href: documentHref(current.id, "original", current.status === "completed") });
  }

  const model: PanelModel = {
    fileId: file.id,
    clientName: client?.name ?? file.clientName,
    orgName: viewer.org.name,
    // Sending is offered when nothing is out and nothing is signed: first time, or after a decline, void or expiry.
    send:
      !archived && !isOpen && current?.status !== "completed"
        ? {
            label: current ? "Send the agreement again" : "Send agreement",
            to: file.clientEmail,
            agreementName: outlook.agreement?.name ?? null,
            blocked: outlook.blocked,
            fixHref: manager ? (outlook.needsAgreement ? "/agreements/new" : "/agreements") : null,
            emailNote:
              outlook.email === "ok"
                ? null
                : outlook.email === "not_configured"
                  ? "Email is not set up for this account, so it will not be emailed. You get a signing link to send yourself."
                  : `It will not be emailed. ${outlook.emailReason ?? ""} You get a signing link to send yourself.`,
          }
        : null,
    open:
      !archived && isOpen
        ? {
            envelopeId: current.id,
            stage: sealing ? "sealing" : current.status === "client_signed" ? "with_company" : current.status === "draft" ? "draft" : "with_client",
            lapsed,
            client:
              client && AWAITING_CLIENT.includes(current.status) && client.status !== "signed" && client.status !== "declined"
                ? { signerId: client.id, name: client.name, email: client.email, signingUrl: lapsed ? null : client.signingUrl }
                : null,
            countersignerId: !sealing && current.canCountersign && company ? company.id : null,
            remindName: !sealing && current.status === "client_signed" && company && !current.canCountersign ? company.name : null,
            replaceBlocked: outlook.blocked,
            canEmail: outlook.email !== "not_configured",
          }
        : null,
    documents,
  };

  const recent = [...events].reverse();
  const shown = recent.slice(0, 12);
  const older = recent.slice(12);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words">{file.clientName}</span>
            <StatusBadge status={file.agreementStatus} className="font-sans" />
          </span>
        }
        description={
          <>
            File <span className="tabular font-semibold text-ink">{file.reference}</span>
            {file.clientCompany ? `, ${file.clientCompany}` : ""}
          </>
        }
        back={{ href: archived ? "/files?view=archived" : "/files", label: archived ? "Archived files" : "Files" }}
        actions={
          <>
            <ButtonLink href={`/files/${file.id}/edit`} variant="secondary">
              Edit details
            </ButtonLink>
            <FileArchiveButton fileId={file.id} archived={archived} hasOpenAgreement={isOpen} clientSigned={isOpen && current.status === "client_signed"} clientName={client?.name ?? file.clientName} />
          </>
        }
      />

      {query.saved === "1" ? (
        <Notice tone="success" className="mb-6">
          <p>The file details were saved.</p>
        </Notice>
      ) : null}
      {archived ? (
        <Notice tone="info" title={`This file was archived ${onPastDay(file.archivedAt as Date, now, timeZone)}`} className="mb-6">
          <p>It is out of your working list and nothing can be sent for it. Restore it to send an agreement again.</p>
        </Notice>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Sheet className={cx("p-5 sm:p-6", model.open?.countersignerId && "shadow-[inset_4px_0_0_var(--color-flag),var(--shadow-sheet)]")}>
            <SectionTitle className="sr-only">Agreement</SectionTitle>
            {current ? (
              <p className="text-[13px] text-ink-soft">
                {current.templateName}
                {current.sentAt ? `, sent ${shortDate(current.sentAt, now, timeZone)}` : ""}
              </p>
            ) : null}
            <p className="mt-1 font-serif text-xl leading-snug font-semibold [overflow-wrap:anywhere] text-ink">{standing.headline}</p>
            {standing.detail.length > 0 ? <p className="mt-2 max-w-[65ch] [overflow-wrap:anywhere] text-ink-soft">{standing.detail.join(" ")}</p> : null}

            {emailProblems.length > 0 ? (
              emailOff ? (
                // For the client the headline already says so, and the link is right below it.
                !model.open?.client && company && company.status !== "signed" && !current?.canCountersign ? (
                  <Notice tone="warning" title={`${company.name} was not emailed`} className="mt-4">
                    <p>Email is not set up for this account. Ask them to sign in, open this file and sign for the company.</p>
                  </Notice>
                ) : null
              ) : (
                <Notice tone="warning" title={emailProblems.length === 1 ? "An email did not go through" : "Some emails did not go through"} className="mt-4">
                  <ul className="space-y-1">
                    {emailProblems.map((e) => (
                      <li key={e.id}>
                        {e.description.replace(/[.\s]+$/, "")}. <span className="tabular whitespace-nowrap text-ink-faint">{formatDate(e.createdAt, { time: true, timeZone })}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">The signing link still works, so you can always send it yourself.</p>
                </Notice>
              )
            ) : null}

            <AgreementPanel model={model} />
          </Sheet>

          {current && current.signers.length > 0 ? (
            <section aria-labelledby="signers-title">
              <SectionTitle className="mb-2">
                <span id="signers-title">Who signs</span>
              </SectionTitle>
              <ul className="overflow-hidden rounded-lg border border-rule bg-paper">
                {current.signers.map((signer) => (
                  <li key={signer.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-rule-soft px-4 py-3 last:border-b-0">
                    <span className="min-w-0">
                      <span className="block font-semibold break-words">{signer.name}</span>
                      <span className="block text-[13px] break-all text-ink-soft">
                        {signer.role === "client" ? "Client" : `Signs for ${viewer.org.name}`}, {signer.email}
                      </span>
                    </span>
                    <span className={cx("text-sm", signer.status === "signed" ? "font-semibold text-signed" : signer.status === "declined" ? "font-semibold text-stop" : "text-ink-soft")}>
                      {signerStanding(signer, current, now, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="timeline-title">
            <SectionTitle className="mb-2">
              <span id="timeline-title">Timeline</span>
            </SectionTitle>
            <div className="rounded-lg border border-rule bg-paper px-4 py-1">
              <ol className="text-sm">
                {shown.map((event) => (
                  <TimelineEntry key={event.id} event={event} timeZone={timeZone} />
                ))}
              </ol>
              {older.length > 0 ? (
                <details className="border-t border-rule-soft">
                  <summary className="cursor-pointer py-2.5 text-sm font-semibold text-ink-soft hover:text-ink">
                    Show {older.length} earlier {older.length === 1 ? "entry" : "entries"}
                  </summary>
                  <ol className="text-sm">
                    {older.map((event) => (
                      <TimelineEntry key={event.id} event={event} timeZone={timeZone} />
                    ))}
                  </ol>
                </details>
              ) : null}
            </div>
            <p className="mt-2 text-[13px] text-ink-soft">
              Newest first. Times are shown in {timeZone === "UTC" ? "UTC" : timeZone.replace(/_/g, " ")}
              {timeZone === "UTC" && manager ? (
                <>
                  ; set your company&rsquo;s time zone in{" "}
                  <Link href="/settings/company" className="underline">
                    Settings
                  </Link>
                </>
              ) : null}
              .
            </p>
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          <section aria-labelledby="client-title" className="rounded-lg border border-rule bg-paper p-4">
            <SectionTitle className="mb-1">
              <span id="client-title">Client</span>
            </SectionTitle>
            <dl className="text-sm">
              <Detail label="Name">{file.clientName}</Detail>
              <Detail label="Email">
                <a href={`mailto:${file.clientEmail}`} className="underline">
                  {file.clientEmail}
                </a>
              </Detail>
              {file.clientCompany ? <Detail label="Company">{file.clientCompany}</Detail> : null}
              {file.clientTitle ? <Detail label="Title">{file.clientTitle}</Detail> : null}
              {file.clientPhone ? (
                <Detail label="Phone">
                  <a href={`tel:${file.clientPhone.replace(/[^\d+]/g, "")}`} className="underline">
                    {file.clientPhone}
                  </a>
                </Detail>
              ) : null}
              <Detail label="Reference">
                <span className="tabular">{file.reference}</span>
              </Detail>
              <Detail label="Created">{formatDate(file.createdAt, { timeZone })}</Detail>
              {file.description ? (
                <Detail label="Notes">
                  <span className="whitespace-pre-wrap">{file.description}</span>
                </Detail>
              ) : null}
              {Object.entries(file.data ?? {}).map(([key, value]) => (
                <Detail key={key} label={key.replace(/_/g, " ")}>
                  {value}
                </Detail>
              ))}
            </dl>
          </section>

          {earlier.length > 0 ? (
            <section aria-labelledby="earlier-title" className="rounded-lg border border-rule bg-paper p-4">
              <SectionTitle className="mb-1">
                <span id="earlier-title">Earlier agreements on this file</span>
              </SectionTitle>
              <ul className="text-sm">
                {earlier.map((envelope) => {
                  const reason = envelope.status === "voided" ? envelope.voidReason : envelope.status === "declined" ? envelope.declineReason : null;
                  return (
                    <li key={envelope.id} className="border-b border-rule-soft py-2.5 last:border-b-0">
                      <span className="block font-semibold break-words">{envelope.templateName}</span>
                      <span className="block text-[13px] text-ink-soft">
                        {CLOSED_LABEL[envelope.status] ?? "Open"} {shortDate(envelope.completedAt ?? envelope.updatedAt, now, timeZone)}
                        {envelope.sentAt ? `, sent ${shortDate(envelope.sentAt, now, timeZone)}` : ""}
                      </span>
                      {reason ? <span className="block text-[13px] break-words text-ink-soft">&ldquo;{reason.replace(/\s+/g, " ").trim()}&rdquo;</span> : null}
                      <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                        {envelope.status === "completed" && envelope.finalBlobId ? (
                          <a href={documentHref(envelope.id, "signed", true)} className="underline">
                            Download the signed PDF
                          </a>
                        ) : null}
                        <a href={documentHref(envelope.id, "original")} target="_blank" rel="noreferrer" className="underline">
                          View as sent
                        </a>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
