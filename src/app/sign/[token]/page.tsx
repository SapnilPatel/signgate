import type { Metadata } from "next";
import { getViewer } from "@/lib/auth/session";
import { getRequestMeta } from "@/lib/request";
import { ServiceError } from "@/lib/services/context";
import { getSigningSession, type SigningSession } from "@/lib/services/signing";
import { buttonClass, formatDate } from "@/components/ui";
import { Ceremony } from "@/components/signing/ceremony";
import { StateScreen, readableOn, safeColor } from "@/components/signing/brand";
import { RefreshButton } from "@/components/signing/refresh-button";

// The address holds the signing secret: never indexed, never sent on as a referrer, never cached.
export const metadata: Metadata = {
  title: "Sign your agreement",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

type Known = Exclude<SigningSession, { state: "unknown" }>;

/** The company's reply-to address, when the session carries one. */
function contactEmailOf(session: Known): string | null {
  const value = (session.org as { replyToEmail?: unknown }).replyToEmail;
  return typeof value === "string" && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value) ? value : null;
}

function Contact({ session }: { session: Known }) {
  const email = contactEmailOf(session);
  return (
    <p>
      Questions? Contact {session.org.name}
      {email ? (
        <>
          {" "}
          at{" "}
          <a href={`mailto:${email}`} className="font-semibold text-ink underline underline-offset-2">
            {email}
          </a>
          .
        </>
      ) : (
        " directly."
      )}
    </p>
  );
}

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let session: SigningSession;
  try {
    session = await getSigningSession(token, await getRequestMeta());
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    // Too many requests, most likely: say so and offer the way forward.
    return (
      <StateScreen brand={null} title="This page could not be opened just now" actions={<RefreshButton variant="primary">Try again</RefreshButton>}>
        <p>{err.message}</p>
        <p>Nothing has been lost. Your signing link still works.</p>
      </StateScreen>
    );
  }

  if (session.state === "unknown") {
    return (
      <StateScreen brand={null} title="This signing link does not work">
        <p>{session.message}</p>
        <p>If you copied the link by hand, check that the whole address was copied, with nothing cut off at the end.</p>
      </StateScreen>
    );
  }

  const { org } = session;
  // Someone signing for the company while signed in came from the product and needs a way back to it.
  // The file's own page when the session names the file, the file list otherwise.
  let backHref: string | null = null;
  if (session.signer.role === "company" && (await getViewer().catch(() => null))) {
    const fileId = (session as { fileId?: unknown }).fileId;
    backHref = typeof fileId === "string" && /^[\w-]{1,64}$/.test(fileId) ? `/files/${fileId}` : "/files";
  }
  const back = backHref ? (
    <a href={backHref} className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
      {backHref === "/files" ? "Back to your files" : "Back to the file"}
    </a>
  ) : null;
  const base = `/api/sign/${encodeURIComponent(token)}`;
  const brandButton = { backgroundColor: safeColor(org.brandColor), color: readableOn(org.brandColor) };
  const subject = (
    <p className="text-sm">
      {session.agreementName}, file {session.fileReference}
    </p>
  );

  switch (session.state) {
    case "ready":
      return (
        <Ceremony
          token={token}
          org={org}
          agreementName={session.agreementName}
          fileReference={session.fileReference}
          signer={session.signer}
          pages={session.pages}
          fields={session.fields}
          defaults={session.defaults}
          expiresOn={session.expiresAt ? formatDate(session.expiresAt) : null}
          contactEmail={contactEmailOf(session)}
          backHref={backHref}
        />
      );

    case "completed":
      return (
        <StateScreen
          brand={org}
          tone="signed"
          title="This agreement is signed and complete"
          actions={
            session.canDownloadSigned ? (
              <>
                <a href={`${base}/signed`} className={buttonClass("primary", "lg", "w-full sm:w-auto")} style={brandButton}>
                  Download signed copy
                </a>
                <a href={`${base}/signed?view=1`} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
                  Open in the browser
                </a>
                {back}
              </>
            ) : (
              <>
                <RefreshButton>Check for the signed copy</RefreshButton>
                {back}
              </>
            )
          }
          footer={
            <>
              <Contact session={session} />
              <p className="mt-2">
                Anyone you give the PDF to can confirm it is genuine on the{" "}
                <a href="/verify" className="font-semibold text-ink underline underline-offset-2">
                  verification page
                </a>
                .
              </p>
            </>
          }
        >
          {subject}
          <p>
            {session.completedAt ? `Everyone signed, and the agreement was completed on ${formatDate(session.completedAt, { time: true })}. ` : ""}
            {session.canDownloadSigned
              ? "Download your copy and keep it. This link keeps working if you need it again."
              : "The final copy is still being prepared. It will be ready to download here shortly."}
          </p>
        </StateScreen>
      );

    case "signed":
      return (
        <StateScreen
          brand={org}
          tone="signed"
          title={session.signer.role === "company" ? `You have signed for ${org.name}` : "You have signed this agreement"}
          actions={
            <>
              <RefreshButton>Check for the completed copy</RefreshButton>
              {back}
            </>
          }
          footer={<Contact session={session} />}
        >
          {subject}
          <p>
            {session.signedAt ? `Your signature was recorded on ${formatDate(session.signedAt, { time: true })}. ` : ""}
            {session.signer.role === "company"
              ? "The final copy is being prepared and can be downloaded from this link when it is ready."
              : `Nothing more is needed from you. When ${org.name} has signed their part, the completed agreement can be downloaded from this link, so keep it.`}
          </p>
        </StateScreen>
      );

    case "not_your_turn":
      return (
        <StateScreen brand={org} title="Not ready for your signature yet" actions={<RefreshButton>Check again</RefreshButton>} footer={<Contact session={session} />}>
          {subject}
          <p>{session.message}</p>
        </StateScreen>
      );

    case "voided":
      return (
        <StateScreen brand={org} title="This signing request was cancelled" footer={<Contact session={session} />}>
          {subject}
          <p>{session.message}</p>
        </StateScreen>
      );

    case "declined":
      return (
        <StateScreen brand={org} title="This agreement was declined" footer={<Contact session={session} />}>
          {subject}
          <p>{session.message}</p>
        </StateScreen>
      );

    case "expired":
      return (
        <StateScreen brand={org} title="This signing link has expired" footer={<Contact session={session} />}>
          {subject}
          <p>{session.message}</p>
          {session.expiresAt ? <p>It stopped working on {formatDate(session.expiresAt)}. Nothing was signed.</p> : null}
        </StateScreen>
      );
  }
}
