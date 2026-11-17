import type { Metadata } from "next";
import Link from "next/link";
import {
  getEmailSendingStatus,
  resolveSettings,
} from "@/lib/services/accounts";
import { Notice } from "@/components/ui";
import { ResendVerificationButton } from "../../welcome/resend-button";
import { settingsContext } from "../guard";
import { Section } from "../parts";

export const metadata: Metadata = { title: "Email status" };

export default async function EmailStatusPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { viewer, actor } = ctx;
  const status = await getEmailSendingStatus(actor);
  const replyTo = resolveSettings(viewer.org).replyToEmail;

  return (
    <>
      <Section
        id="status"
        title="Can Signgate email your clients?"
        description="Two things have to be true: this installation of Signgate must be connected to an email service, and your company's owner must have confirmed their own email address."
      >
        <dl className="divide-y divide-rule-soft border-y border-rule-soft text-sm">
          <Row
            term="Email service"
            ok={status.emailConfigured}
            yes="Connected. Signgate can send email."
            no="Not connected. Nothing is emailed from this installation."
          />
          {status.emailConfigured ? (
            <Row
              term="Owner's email address"
              ok={status.canEmailOutside}
              yes="Confirmed."
              no="Not confirmed yet. Emails to people outside your company are on hold."
            />
          ) : null}
          {status.emailConfigured ? (
            <Row
              term="Your email address"
              ok={status.viewerVerified}
              yes={`Confirmed (${viewer.user.email}).`}
              no={`Not confirmed yet (${viewer.user.email}).`}
            />
          ) : null}
        </dl>

        <div className="mt-5 space-y-4">
          {!status.emailConfigured ? (
            <Notice
              tone="info"
              title="Agreements still work: you share the links yourself"
            >
              Whenever an agreement or invitation would have been emailed,
              Signgate shows you its link to copy and send by your own email or
              text message. Reminders are not sent. To have Signgate send them
              for you, whoever runs this installation needs to connect an email
              service.
            </Notice>
          ) : status.canEmailOutside ? (
            <Notice tone="success" title="Everything is in place">
              Agreements, reminders, signed copies and invitations are emailed
              for you
              {replyTo ? (
                <>, and clients&rsquo; replies go to {replyTo}</>
              ) : null}
              .
            </Notice>
          ) : (
            <Notice tone="info" title="Emails to clients are on hold">
              {status.viewerIsOwner ? (
                <>
                  We emailed a confirmation link to {viewer.user.email}. Open it
                  and emails start going out. Until then every agreement shows
                  you its signing link to send yourself.
                </>
              ) : (
                <>
                  Your company&rsquo;s owner has to open the confirmation link
                  we emailed them. Until then every agreement shows you its
                  signing link to send yourself.
                </>
              )}
            </Notice>
          )}
          {status.emailConfigured && !status.viewerVerified ? (
            <ResendVerificationButton email={viewer.user.email} />
          ) : null}
        </div>
      </Section>

      <Section
        id="replies"
        title="Where replies go"
        description="When a client replies to an agreement email."
      >
        <p className="text-sm text-ink-soft">
          {replyTo ? (
            <>
              Replies go to{" "}
              <span className="font-semibold break-all text-ink">
                {replyTo}
              </span>
              .
            </>
          ) : (
            <>
              No reply-to address is set, so replies go to the address the
              emails are sent from, which may not be an inbox anyone reads.
            </>
          )}{" "}
          <Link
            href="/settings/signing#sending"
            className="font-semibold text-ink underline"
          >
            Change the reply-to address
          </Link>
        </p>
      </Section>
    </>
  );
}

function Row({
  term,
  ok,
  yes,
  no,
}: {
  term: string;
  ok: boolean;
  yes: string;
  no: string;
}) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 py-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="font-semibold text-ink">{term}</dt>
      <dd className={ok ? "text-ink-soft" : "text-ink"}>{ok ? yes : no}</dd>
    </div>
  );
}
