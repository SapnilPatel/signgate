import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/session";
import { LogInForm } from "../forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getViewer()) redirect("/files");
  const { next } = await searchParams;
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">Sign in</h1>
      <div className="mt-6">
        <LogInForm next={typeof next === "string" ? next : undefined} />
      </div>
      <p className="mt-6 flex justify-between text-sm text-ink-soft">
        <Link href="/forgot-password" className="underline hover:text-ink">
          Forgot your password?
        </Link>
        <Link href="/signup" className="underline hover:text-ink">
          Create an account
        </Link>
      </p>
    </>
  );
}
