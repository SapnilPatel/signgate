import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/site/chrome";
import { VerifyDocument } from "./verify-document";

export const metadata: Metadata = {
  title: "Verify a signed agreement",
  description: "Check that a signed PDF is the genuine, unaltered agreement that was sealed when everyone signed.",
};

export default function VerifyPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[720px] flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-serif text-[30px] leading-tight font-semibold text-ink">Verify a signed agreement</h1>
        <p className="mt-2 max-w-[62ch] text-ink-soft">
          Choose the signed PDF you were given. Your browser works out the file&rsquo;s fingerprint on this device and only the fingerprint is
          checked: the document is not uploaded.
        </p>
        <VerifyDocument />
        <section aria-labelledby="verify-meaning" className="mt-10 border-t border-rule pt-6">
          <h2 id="verify-meaning" className="text-base font-semibold text-ink">
            What a match means
          </h2>
          <p className="mt-2 max-w-[62ch] text-ink-soft">
            A match means this exact file, byte for byte, is the one that was sealed when the last person signed. If anything had been changed
            afterwards, even a single character, it would not match.
          </p>
          <p className="mt-2 max-w-[62ch] text-[13px] text-ink-faint">
            A match confirms the file, not who was holding the pen. The audit certificate on the last page of the PDF records who signed, when, and
            how each person was reached.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
