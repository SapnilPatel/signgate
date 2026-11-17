import type { Metadata } from "next";
import { getViewer } from "@/lib/auth/session";
import { getRequestMeta } from "@/lib/request";
import { verifyEmail } from "@/lib/services/accounts";
import { ServiceError } from "@/lib/services/context";
import { ButtonLink, Notice } from "@/components/ui";
import { ResendVerificationButton } from "../../../(app)/welcome/resend-button";

// The address carries a secret: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Confirm your email address", referrer: "no-referrer", robots: { index: false } };

export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const viewer = await getViewer();

  let outcome: { ok: true; email: string; already: boolean } | { ok: false; message: string };
  try {
    const result = await verifyEmail(token, await getRequestMeta());
    outcome = { ok: true, email: result.user.email, already: result.alreadyVerified };
  } catch (err) {
    // Anything but a dead link is a bug and belongs to the error page.
    if (!(err instanceof ServiceError)) throw err;
    outcome = { ok: false, message: err.message };
  }

  if (outcome.ok) {
    return (
      <>
        <h1 className="font-serif text-2xl font-semibold">Your email address is confirmed</h1>
        <div className="mt-6 space-y-4">
          <Notice tone="success" title={outcome.already ? "This address was already confirmed" : `Thank you. ${outcome.email} is confirmed.`}>
            Agreements, reminders and signed copies can now be emailed to your clients for you.
          </Notice>
          {viewer ? (
            <ButtonLink href="/welcome" className="w-full">
              Continue
            </ButtonLink>
          ) : (
            <ButtonLink href="/login" className="w-full">
              Sign in
            </ButtonLink>
          )}
        </div>
      </>
    );
  }

  const canResend = viewer !== null && viewer.user.emailVerifiedAt === null;
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">This confirmation link no longer works</h1>
      <div className="mt-6 space-y-4">
        {viewer && viewer.user.emailVerifiedAt !== null ? (
          <>
            <Notice tone="info" title="Nothing more to do">
              The link has expired or was already used, and the address you are signed in with, {viewer.user.email}, is already
              confirmed.
            </Notice>
            <ButtonLink href="/files" className="w-full">
              Go to your files
            </ButtonLink>
          </>
        ) : canResend ? (
          <>
            <Notice tone="error" title="The link has expired or was already used">
              Confirmation links work once, for 48 hours, and only the newest one works. Send yourself a new one.
            </Notice>
            <ResendVerificationButton email={viewer.user.email} />
          </>
        ) : (
          <>
            <Notice tone="error" title="The link has expired or was already used">
              Sign in and use &ldquo;Resend the email&rdquo; at the top of the page to get a new one.
            </Notice>
            <ButtonLink href="/login" className="w-full">
              Sign in
            </ButtonLink>
          </>
        )}
      </div>
    </>
  );
}
