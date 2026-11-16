import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/session";
import { SignUpForm } from "../forms";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignupPage() {
  if (await getViewer()) redirect("/files");
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">Create your company account</h1>
      <p className="mt-1 text-sm text-ink-soft">
        You will upload your agreement next. Teammates can be invited afterwards.
      </p>
      <div className="mt-6">
        <SignUpForm />
      </div>
      <p className="mt-6 text-sm text-ink-soft">
        Already have an account?{" "}
        <Link href="/login" className="underline hover:text-ink">
          Sign in
        </Link>
      </p>
    </>
  );
}
