import type { Metadata } from "next";
import { isPasswordResetTokenValid } from "@/lib/services/accounts";
import { ButtonLink, Notice } from "@/components/ui";
import { ResetPasswordForm } from "../../forms";

export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer", robots: { index: false } };

export default async function ResetPasswordPage({ params }: PageProps<"/reset-password/[token]">) {
  const { token } = await params;
  const valid = await isPasswordResetTokenValid(token);
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">Choose a new password</h1>
      {valid ? (
        <div className="mt-6">
          <ResetPasswordForm token={token} />
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <Notice tone="error" title="This reset link no longer works">
            Reset links work once and expire after an hour. Request a new one.
          </Notice>
          <ButtonLink href="/forgot-password" className="w-full">
            Send a new link
          </ButtonLink>
        </div>
      )}
    </>
  );
}
