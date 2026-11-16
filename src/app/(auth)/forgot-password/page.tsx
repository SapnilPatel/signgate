import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "../forms";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-soft">Enter the email you sign in with and we will send you a link.</p>
      <div className="mt-6">
        <ForgotPasswordForm />
      </div>
      <p className="mt-6 text-sm text-ink-soft">
        <Link href="/login" className="underline hover:text-ink">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
