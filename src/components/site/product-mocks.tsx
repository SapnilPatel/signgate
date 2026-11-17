/**
 * Static renderings of the product for the landing page, built from the same
 * primitives and status vocabulary the product uses, so what a visitor sees
 * here is what they get after signing up. Everything is illustrative test data.
 *
 * Each rendering is exposed to assistive technology as a single described image:
 * the controls inside are spans, not real buttons, so nothing fake takes focus.
 */
import type { ReactNode } from "react";
import { StatusBadge, cx, type AgreementStatus } from "@/components/ui";
import { Flag } from "./chrome";

function Mock({ label, caption, children, className }: { label: string; caption: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <div role="img" aria-label={label} className="select-none">
        <div aria-hidden="true">{children}</div>
      </div>
      <figcaption className="mt-3 text-[13px] text-ink-faint">{caption}</figcaption>
    </figure>
  );
}

const fauxButton = "inline-flex h-8 items-center rounded-md bg-ink px-3 text-[13px] font-semibold whitespace-nowrap text-white";

// ---------------------------------------------------------------------------
// The files list
// ---------------------------------------------------------------------------

const FILES: { reference: string; client: string; matter: string; status: AgreementStatus; activity: string }[] = [
  { reference: "F-2026-0142", client: "Marisol Vega", matter: "Residential purchase", status: "out_for_signature", activity: "Reminder sent this morning" },
  { reference: "F-2026-0141", client: "Okafor Building Supply Ltd.", matter: "Commercial lease review", status: "out_for_signature", activity: "Opened yesterday, not signed" },
  { reference: "F-2026-0140", client: "Dana Whitlock", matter: "Estate administration", status: "awaiting_countersign", activity: "Client signed 2 hours ago" },
  { reference: "F-2026-0139", client: "Tomasz Brandt", matter: "Refinance", status: "signed", activity: "Signed Nov 12" },
  { reference: "F-2026-0138", client: "Priya Raman", matter: "Incorporation", status: "signed", activity: "Signed Nov 11" },
];

export function FilesListMock({ className }: { className?: string }) {
  return (
    <Mock
      className={className}
      label="The files list in Signgate. Five files, each showing the client and where the agreement stands: two waiting on the client, one waiting on the firm to countersign, two signed."
      caption="The files list. Yellow flags are the ones still waiting on a client. Example data."
    >
      <div className="overflow-hidden rounded-lg border border-rule bg-paper shadow-sheet">
        <div className="flex items-center gap-5 border-b border-rule px-4 py-2.5">
          <span className="font-serif text-base font-semibold">Signgate</span>
          <span className="rounded-md bg-rule-soft px-2.5 py-1 text-[13px] font-semibold">Files</span>
          <span className="text-[13px] text-ink-soft">Agreements</span>
          <span className="hidden text-[13px] text-ink-soft sm:inline">Settings</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <span className="font-serif text-xl font-semibold">Files</span>
          <span className={fauxButton}>New file</span>
        </div>
        <table className="w-full table-fixed border-t border-rule text-left text-[13px]">
          <colgroup>
            <col className="hidden w-[112px] md:table-column" />
            <col />
            <col className="w-[132px] sm:w-[150px]" />
            <col className="hidden w-[27%] lg:table-column" />
          </colgroup>
          <thead className="text-ink-faint">
            <tr>
              <th className="hidden px-4 py-2 font-normal md:table-cell">File</th>
              <th className="px-4 py-2 font-normal">Client</th>
              <th className="px-2 py-2 font-normal">Agreement</th>
              <th className="hidden px-4 py-2 font-normal lg:table-cell">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {FILES.map((f) => (
              <tr key={f.reference} className="border-t border-rule-soft">
                <td className="tabular hidden py-2.5 pr-2 pl-4 whitespace-nowrap text-ink-soft md:table-cell">{f.reference}</td>
                <td className="px-4 py-2.5">
                  <span className="block truncate font-semibold">{f.client}</span>
                  <span className="block truncate text-ink-soft">{f.matter}</span>
                </td>
                <td className="px-2 py-2.5">
                  <StatusBadge status={f.status} />
                </td>
                <td className="hidden truncate px-4 py-2.5 text-ink-soft lg:table-cell">{f.activity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Mock>
  );
}

// ---------------------------------------------------------------------------
// The signing page, as the client sees it on a phone
// ---------------------------------------------------------------------------

export function SigningPageMock({ className }: { className?: string }) {
  return (
    <Mock
      className={className}
      label="The signing page as a client sees it on a phone. The firm's name is at the top, the agreement is shown in full with the client's details already filled in, a yellow flag marks the signature line, and below it are a consent tick box and a Sign agreement button."
      caption="What your client sees. No account, no app. Example data."
    >
      <div className="mx-auto w-full max-w-[340px] overflow-hidden rounded-[22px] border border-rule bg-desk shadow-sheet">
        <div className="border-b border-rule bg-paper px-4 py-3">
          <p className="font-serif text-[15px] font-semibold">Harbour Street Law</p>
          <p className="text-xs text-ink-soft">Client services agreement for Marisol Vega</p>
        </div>

        <div className="px-3 pt-3">
          {/* The agreement page itself: whatever the company uploaded, shown as it is. */}
          <div className="relative rounded-sm border border-rule bg-paper px-4 py-4 font-serif text-[10.5px] leading-[1.55] text-ink-soft">
            <p className="text-center text-[11.5px] font-semibold text-ink">Client services agreement</p>
            <p className="mt-2">
              This agreement is made on <Filled>November 16, 2026</Filled> between Harbour Street Law and <Filled>Marisol Vega</Filled> (the
              client).
            </p>
            <p className="mt-1.5">
              <span className="font-semibold text-ink">7. Fees.</span> The client will pay the fees set out in Schedule A within 30 days
              of each invoice.
            </p>
            <p className="mt-1.5">
              <span className="font-semibold text-ink">8. Ending this agreement.</span> Either party may end it by giving written notice
              to the other.
            </p>
            <div className="mt-4 grid grid-cols-[auto_1fr] items-end gap-x-3">
              <div className="w-[76px]">
                <p className="h-9 pt-3 text-ink">Nov 16, 2026</p>
                <p className="mt-1 border-t border-ink-faint pt-0.5 font-sans text-[9.5px]">Date</p>
              </div>
              <div>
                <div className="flex h-9 items-center rounded-sm border border-dashed border-flag-ink/40 bg-flag-soft px-2 font-sans text-[11px] font-semibold text-flag-ink">
                  Tap to sign
                </div>
                <p className="mt-1 border-t border-ink-faint pt-0.5 font-sans text-[9.5px]">Client signature</p>
              </div>
            </div>
            {/* The tab sticks out past the page edge, the way a paper flag does. */}
            <Flag className="absolute -right-5 bottom-[30px] py-1 pr-3 pl-5 font-sans text-xs" notch={9}>
              Sign here
            </Flag>
          </div>
        </div>

        <div className="mt-3 border-t border-rule bg-paper px-4 py-3.5">
          <p className="flex items-start gap-2 text-xs leading-snug text-ink-soft">
            <span className="mt-px inline-block size-3.5 shrink-0 rounded-[3px] border border-ink-faint bg-paper" />
            <span>
              I agree to sign this agreement electronically. <span className="underline">Read the disclosure</span>
            </span>
          </p>
          <span className="mt-3 flex h-11 items-center justify-center rounded-md bg-ink text-sm font-semibold text-white">Sign agreement</span>
          <p className="mt-2.5 text-center text-xs text-ink-faint">1 signature needed · Decline to sign</p>
        </div>
      </div>
    </Mock>
  );
}

function Filled({ children }: { children: ReactNode }) {
  return <span className="rounded-[2px] bg-note-soft px-0.5 text-ink">{children}</span>;
}

// ---------------------------------------------------------------------------
// The three steps
// ---------------------------------------------------------------------------

/** Step 1: the uploaded agreement with the blanks Signgate found. */
export function AgreementSetupMock() {
  const line = "h-[5px] rounded-full bg-rule";
  return (
    <Mock
      label="An uploaded agreement with its blanks marked: the client's name and the date are filled in from the file, and the client and company signature lines are marked for signing."
      caption="Signgate finds the blanks in your document. You check them once."
    >
      <div className="rounded-lg border border-rule bg-paper p-4 shadow-sheet">
        <div className="flex items-center justify-between gap-3 border-b border-rule-soft pb-3">
          <span className="truncate text-[13px] font-semibold">Client services agreement.docx</span>
          <span className="shrink-0 text-xs text-ink-soft">4 pages, 6 fields found</span>
        </div>
        <div className="mx-auto mt-4 max-w-[300px] rounded-sm border border-rule px-5 py-5">
          <div className={cx(line, "mx-auto w-1/2 bg-ink-faint")} />
          <div className="mt-4 flex items-center gap-2">
            <div className={cx(line, "w-10")} />
            <FieldBox tone="fill">Client name</FieldBox>
            <div className={cx(line, "flex-1")} />
          </div>
          <div className={cx(line, "mt-2.5")} />
          <div className={cx(line, "mt-2.5 w-11/12")} />
          <div className={cx(line, "mt-2.5 w-4/5")} />
          <div className="mt-5 grid grid-cols-2 gap-4">
            <div>
              <FieldBox tone="sign" tall>
                Client signs
              </FieldBox>
              <div className="mt-1 border-t border-ink-faint" />
            </div>
            <div>
              <FieldBox tone="company" tall>
                We countersign
              </FieldBox>
              <div className="mt-1 border-t border-ink-faint" />
            </div>
          </div>
        </div>
      </div>
    </Mock>
  );
}

function FieldBox({ children, tone, tall }: { children: ReactNode; tone: "fill" | "sign" | "company"; tall?: boolean }) {
  const tones = {
    fill: "border-note/40 bg-note-soft text-note",
    sign: "border-flag-ink/40 bg-flag-soft text-flag-ink",
    company: "border-ink-faint bg-rule-soft text-ink-soft",
  };
  return (
    <span
      className={cx(
        "flex items-center rounded-sm border border-dashed px-1.5 text-[10.5px] font-semibold whitespace-nowrap",
        tall ? "h-8" : "h-[18px]",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Step 2: opening a file. */
export function NewFileMock() {
  const field = "mt-1 flex h-9 items-center rounded-md border border-rule px-3 text-[13px]";
  return (
    <Mock
      label="The new file form with the client's name and email filled in, and a button that opens the file and sends the agreement."
      caption="Opening a file is the only thing you do per client."
    >
      <div className="rounded-lg border border-rule bg-paper p-4 shadow-sheet">
        <p className="font-serif text-lg font-semibold">New file</p>
        <p className="mt-3 text-[13px] font-semibold">Client name</p>
        <p className={field}>Marisol Vega</p>
        <p className="mt-3 text-[13px] font-semibold">Client email</p>
        <p className={field}>
          <span className="truncate">marisol.vega@example.com</span>
        </p>
        <p className="mt-3 text-[13px] text-ink-soft">The client services agreement will be sent as soon as the file is opened.</p>
        <span className={cx(fauxButton, "mt-4 h-10 px-4 text-sm")}>Open file and send agreement</span>
      </div>
    </Mock>
  );
}

/** Step 3: what happens on its own, as the file's timeline records it. */
export function TimelineMock() {
  const events: { when: string; what: string; state?: "waiting" | "signed" }[] = [
    { when: "Mon 9:02 am", what: "Agreement emailed to Marisol Vega", state: "waiting" },
    { when: "Mon 4:40 pm", what: "Marisol Vega opened the agreement" },
    { when: "Wed 9:00 am", what: "Reminder sent" },
    { when: "Wed 12:15 pm", what: "Marisol Vega signed" },
    { when: "Wed 12:15 pm", what: "Countersigned for Harbour Street Law" },
    { when: "Wed 12:16 pm", what: "Signed PDF sealed and emailed to both sides", state: "signed" },
  ];
  return (
    <Mock
      label="A file's timeline: the agreement was emailed on Monday, opened that afternoon, a reminder went out on Wednesday, the client signed at midday, the firm's countersignature was applied, and the sealed PDF was emailed to both sides. The file is now marked signed."
      caption="Every step is recorded on the file and printed on the signing certificate."
    >
      <div className="rounded-lg border border-rule bg-paper p-4 shadow-sheet">
        <div className="flex items-center justify-between gap-3 border-b border-rule-soft pb-3">
          <span className="truncate text-[13px] font-semibold">F-2026-0142, Marisol Vega</span>
          <StatusBadge status="signed" />
        </div>
        <ol className="mt-3 space-y-2.5">
          {events.map((e) => (
            <li key={e.what} className="grid grid-cols-[86px_1fr] gap-3 text-[13px]">
              <span className="tabular text-ink-faint">{e.when}</span>
              <span className={cx(e.state === "signed" ? "font-semibold text-signed" : "text-ink")}>{e.what}</span>
            </li>
          ))}
        </ol>
      </div>
    </Mock>
  );
}
