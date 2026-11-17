import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/auth/session";
import { PRODUCT_NAME } from "@/lib/env";
import { ORG_SETTING_DEFAULTS } from "@/lib/types";
import { ButtonLink } from "@/components/ui";
import { Flag, SiteFooter, SiteHeader } from "@/components/site/chrome";
import { AgreementSetupMock, FilesListMock, NewFileMock, SigningPageMock, TimelineMock } from "@/components/site/product-mocks";

export const metadata: Metadata = {
  title: { absolute: `${PRODUCT_NAME}: your client agreement, signed on every file` },
  description:
    "Add your client agreement once. Every time you open a file it is sent for signature, chased, countersigned and filed, so work starts on time.",
};

// The defaults a new company starts with, quoted on the page so the copy cannot drift from the product.
const { reminderEveryDays, maxReminders, expireAfterDays } = ORG_SETTING_DEFAULTS;

export default async function LandingPage() {
  // Someone who is already signed in came here to work, not to read the pitch.
  if (await getViewer()) redirect("/files");

  return (
    <>
      <SiteHeader landing />
      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-x-12 gap-y-10 px-4 pt-12 pb-14 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-20 lg:pb-20">
          <div>
            <h1 className="font-serif text-[40px] leading-[1.06] font-semibold tracking-[-0.01em] text-ink sm:text-[54px]">
              Your client agreement, signed before work starts. On every file.
            </h1>
            <p className="mt-5 max-w-[54ch] text-[17px] leading-relaxed text-ink-soft">
              {PRODUCT_NAME} sends your standard agreement the moment you open a file, reminds the client until they sign, collects your
              countersignature and files the sealed PDF. Nobody in the office has to chase it.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <ButtonLink href="/signup" size="lg">
                Create an account
              </ButtonLink>
              <a href="#how-it-works" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink-faint">
                See how it works
              </a>
            </div>
            <p className="mt-6 max-w-[54ch] text-sm text-ink-soft">
              For firms that open files: law practices, mortgage brokers, public adjusters, accountants, consultancies.
            </p>
          </div>
          <FilesListMock />
        </section>

        {/* The problem, in the buyer's words */}
        <section aria-labelledby="problem" className="border-y border-rule bg-paper">
          <div className="mx-auto grid max-w-6xl gap-x-12 gap-y-4 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <h2 id="problem" className="font-serif text-[28px] leading-tight font-semibold text-ink">
              It is the same agreement every time. Getting it signed is still a job.
            </h2>
            <div className="max-w-[60ch] space-y-3 text-ink-soft">
              <p>
                Someone fills in the client&rsquo;s name, saves a PDF, emails it, and makes a note to follow up. The client means to sign
                it. A week later someone asks whether the file can start, and nobody is sure.
              </p>
              <p>
                {PRODUCT_NAME} takes that whole routine off the desk. The agreement goes out when the file is opened, and the files list
                always shows which ones are signed and which are still waiting.
              </p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" aria-labelledby="how" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-14 sm:px-6 sm:py-20">
          <h2 id="how" className="font-serif text-[32px] leading-tight font-semibold text-ink">
            How it works
          </h2>
          <p className="mt-2 max-w-[60ch] text-ink-soft">Set it up once. After that there is one step per client, and it is one you already do.</p>

          <ol className="mt-10 space-y-14 sm:space-y-16">
            <Step n={1} title="Add your agreement once" visual={<AgreementSetupMock />}>
              <p>
                Upload the agreement you already use: a PDF, a Word document, a scan or photo, or pasted text. {PRODUCT_NAME} finds the
                blanks, such as the client&rsquo;s name, the date and each signature line, and you check them once.
              </p>
              <p>Nothing about your wording or layout has to change, and you can replace the agreement whenever it is updated.</p>
            </Step>
            <Step n={2} title="Open a file" visual={<NewFileMock />}>
              <p>
                Enter the client&rsquo;s name and email, the way you would when opening any new matter. That is the whole job. If you
                would rather look before it goes, turn off automatic sending and press Send yourself.
              </p>
              <p>Files can also be opened from your own case system, or imported from a spreadsheet.</p>
            </Step>
            <Step n={3} title="It is sent, chased, countersigned and filed" visual={<TimelineMock />}>
              <p>
                The client gets an email with a link and signs on whatever device they are holding. If they do not, they are reminded
                every {reminderEveryDays} days, up to {maxReminders} times, unless you choose a different schedule.
              </p>
              <p>
                When they sign, your countersignature is applied automatically or requested from the person you name. The finished PDF is
                sealed with a signing certificate, emailed to both sides and kept on the file, which now shows as signed.
              </p>
            </Step>
          </ol>
        </section>

        {/* What the client sees */}
        <section aria-labelledby="client-view" className="border-y border-rule bg-paper">
          <div className="mx-auto grid max-w-6xl items-center gap-x-12 gap-y-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2">
            <div className="max-w-[58ch]">
              <h2 id="client-view" className="font-serif text-[32px] leading-tight font-semibold text-ink">
                What your client sees
              </h2>
              <p className="mt-3 text-ink-soft">
                An email sent in your firm&rsquo;s name, with one link. The link opens your agreement, complete, with their
                details already filled in. There is nothing to install and no account to create.
              </p>
              <ul className="mt-5 space-y-3 text-ink-soft">
                <ClientPoint>Each place they need to sign or fill in is marked, so nothing is missed.</ClientPoint>
                <ClientPoint>They sign with a finger on a phone, or a mouse on a computer.</ClientPoint>
                <ClientPoint>They agree to sign electronically before they sign, and can decline and say why.</ClientPoint>
                <ClientPoint>When everyone has signed, they are emailed the finished agreement.</ClientPoint>
              </ul>
            </div>
            <SigningPageMock />
          </div>
        </section>

        {/* Questions */}
        <section id="questions" aria-labelledby="questions-title" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-14 sm:px-6 sm:py-20">
          <h2 id="questions-title" className="font-serif text-[32px] leading-tight font-semibold text-ink">
            Questions firms ask first
          </h2>
          <dl className="mt-8 border-b border-rule">
            <Question q="Does it work with the agreement we already use?">
              <p>
                Yes. Upload it as it is: PDF, Word, a scan or photo of a paper form, or pasted text, up to 200 pages. Your wording, page
                size and layout are kept exactly. {PRODUCT_NAME} only adds the client&rsquo;s details and the signatures on top.
              </p>
              <p>If a blank is missed or misread, you move or add the field yourself before anything is sent.</p>
            </Question>
            <Question q="Is an electronic signature valid?">
              <p>
                For most business agreements, yes. In the United States the ESIGN Act and the Uniform Electronic Transactions Act give
                electronic signatures the same standing as ink, and Canada, the United Kingdom, the European Union and Australia have
                comparable laws. Some documents are excluded, such as wills and certain court and property papers, and the rules differ
                by place, so check with your own counsel for your agreement.
              </p>
              <p>
                What makes a signature hold up is the record behind it. Every signed agreement carries a certificate listing who signed,
                when, from which network address and device, their consent to sign electronically, and a fingerprint of the exact
                document they were shown. <Link href="/security">How the record is kept</Link>.
              </p>
            </Question>
            <Question q="What does the client see?">
              <p>
                Your agreement, under your firm&rsquo;s name, on one page that works on a phone. They do not create an account or
                install anything. Before they sign they are shown a plain{" "}
                <Link href="/legal/esign-disclosure">disclosure about signing electronically</Link>, and afterwards they receive the
                completed copy by email.
              </p>
            </Question>
            <Question q="Can it plug into our case system?">
              <p>
                Yes. {PRODUCT_NAME} has an API: your system creates the file and the agreement goes out exactly as if someone had typed
                it in. Webhooks tell your system when the agreement is sent, viewed, signed, completed, declined or expired, so it can
                mark the matter cleared to start.
              </p>
              <p>If you would rather not involve IT, opening files by hand or importing a spreadsheet works just as well.</p>
            </Question>
            <Question q="What happens if the client ignores it?">
              <p>
                They are reminded automatically, every {reminderEveryDays} days and up to {maxReminders} times by default. The file
                keeps its yellow &ldquo;Waiting on client&rdquo; flag the whole time, so nobody starts work by accident, and you can send
                a reminder yourself or copy the signing link into a text message at any point.
              </p>
              <p>
                If it is still unsigned after {expireAfterDays} days the link expires, the client is told, and the file shows that it
                needs attention. You choose all three numbers in settings.
              </p>
            </Question>
          </dl>
        </section>

        {/* The one call to action */}
        <section aria-labelledby="start" className="border-t border-rule bg-paper">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <h2 id="start" className="max-w-[18ch] font-serif text-[36px] leading-[1.08] font-semibold text-ink sm:text-[46px]">
              The next file you open can send its own agreement.
            </h2>
            <p className="mt-4 max-w-[56ch] text-[17px] text-ink-soft">
              Create an account, add your agreement, and open a file with your own email address as the client to see exactly what yours
              will receive.
            </p>
            {/* A signature line with its flag: this page is waiting on one too. */}
            <div className="mt-10 flex max-w-[560px] flex-wrap items-end gap-x-4 gap-y-4 border-b-2 border-ink pb-3">
              <ButtonLink href="/signup" size="lg">
                Create an account
              </ButtonLink>
              <Flag className="mb-1.5 py-1.5 pr-4 pl-7 text-[15px]" notch={12} decorative>
                Start here
              </Flag>
            </div>
            <p className="mt-3 text-sm text-ink-soft">
              Already have one?{" "}
              <Link href="/login" className="underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Step({ n, title, children, visual }: { n: number; title: string; children: ReactNode; visual: ReactNode }) {
  return (
    <li className="grid items-start gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="grid grid-cols-[auto_1fr] gap-x-4 sm:gap-x-5">
        <span aria-hidden="true" className="font-serif text-[44px] leading-[0.9] font-semibold text-ink-faint sm:text-[56px]">
          {n}
        </span>
        <div>
          <h3 className="font-serif text-2xl leading-tight font-semibold text-ink">
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
          <div className="mt-3 max-w-[56ch] space-y-3 text-ink-soft">{children}</div>
        </div>
      </div>
      <div className="lg:max-w-[460px]">{visual}</div>
    </li>
  );
}

function ClientPoint({ children }: { children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] items-baseline gap-x-3">
      <Flag className="h-[10px] w-[16px]" notch={5} />
      <span>{children}</span>
    </li>
  );
}

function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-12 gap-y-2 border-t border-rule py-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <dt className="font-serif text-xl leading-snug font-semibold text-ink">{q}</dt>
      <dd className="max-w-[64ch] space-y-3 text-ink-soft [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-4">{children}</dd>
    </div>
  );
}
