import type { Metadata } from "next";
import Link from "next/link";
import { PRODUCT_NAME, env } from "@/lib/env";
import { ORG_SETTING_DEFAULTS } from "@/lib/types";
import { API_ERROR_CODES } from "@/lib/api/errors";
import { EXAMPLE_BODIES, EXAMPLE_ERROR, EXAMPLE_IDS, EXAMPLE_KEY, EXAMPLE_RESPONSES, EXAMPLE_WEBHOOKS, VERIFY_NODE, VERIFY_PYTHON, pretty } from "@/lib/api/examples";
import { IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_WINDOW_SECONDS } from "@/lib/api/idempotency";
import { API_RATE_LIMIT, MAX_BODY_BYTES } from "@/lib/api/http";
import { TICK_INTERVAL_SECONDS } from "@/lib/api/tick";
import { SEND_LIMITS } from "@/lib/services/envelopes";
import { AGREEMENT_STATUSES, FILE_LIMITS } from "@/lib/services/files";
import { MAX_WEBHOOKS_PER_ORG, WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS, webhookRetryDelayMs, type WebhookEventName } from "@/lib/services/webhooks";
import { Code, Endpoint, Params, RefTable, Section, prose } from "./parts";

export const metadata: Metadata = {
  title: "API reference",
  description: `Create files in ${PRODUCT_NAME} from your case-management or CRM system so the client agreement goes out for signature with nobody having to remember.`,
};

/*
 * Every number, status, error code and example on this page comes from the code that
 * enforces or produces it. If you find yourself typing a JSON response or a limit into
 * this file, put it in src/lib/api/examples.ts (or import the constant) instead.
 */

type Json = Record<string, unknown>;

function curl(base: string, method: string, path: string, body?: Json, extraHeaders: string[] = []): string {
  const lines = [`curl ${method === "GET" ? "" : `-X ${method} `}"${base}/api/v1${path}"`, `  -H "Authorization: Bearer ${EXAMPLE_KEY}"`];
  for (const header of extraHeaders) lines.push(`  -H "${header}"`);
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${pretty(body)}'`);
  }
  return lines.join(" \\\n");
}

const FILE_STATUS_MEANING: Record<(typeof AGREEMENT_STATUSES)[number], string> = {
  no_agreement: "Nothing is out for signature: none was sent, or the one that was sent has been cancelled.",
  out_for_signature: "The agreement is with the client, waiting for their signature.",
  awaiting_countersign: "The client has signed. Your company's own signer has not yet.",
  signed: "Everyone has signed and the sealed copy exists. Work may start.",
  declined: "The client, or your company's signer, declined to sign.",
  needs_attention: "The request expired unsigned or could not be delivered. Someone should look at the file.",
};

const ENVELOPE_STATUS_MEANING: [string, string][] = [
  ["draft", "Created, but the request has not been emailed to the client yet. The signing link already works."],
  ["sent", "Emailed to the client. Not opened yet."],
  ["viewed", "The client has opened the agreement."],
  ["client_signed", "The client has signed; waiting for your company's signature or for the final copy."],
  ["completed", "Everyone has signed. The sealed PDF can be downloaded."],
  ["declined", "A signer declined. decline_reason holds what they wrote, if anything."],
  ["voided", "Cancelled by your company, or replaced by a newer request. void_reason says why."],
  ["expired", "Nobody signed before expires_at. Send a new one."],
];

const DELIVERY_MEANING: [string, string][] = [
  ["emailed", "The request is on its way to the client's inbox."],
  ["email_not_configured", "This deployment has no email provider, so nothing is emailed. Pass signing_url to the client yourself."],
  ["email_failed", "The email provider refused the message. Pass signing_url on yourself, or correct the address and send again."],
  ["email_unverified", "Your company's owner has not confirmed their own email address yet, so nothing is emailed to clients. The link works."],
];

const EVENT_MEANING: Record<WebhookEventName, [string, string]> = {
  "file.created": ["A file was created, by any route: the API, the screen, an import or an intake link.", "file (the whole file)"],
  "agreement.sent": ["A signing request was created for a file.", "sentAt, clientSignerId"],
  "agreement.viewed": ["The client opened the agreement for the first time.", "viewedAt"],
  "agreement.signed": ["The client signed. If your company countersigns, that is still to come.", "signedAt, signer"],
  "agreement.completed": ["Everyone has signed and the sealed copy exists. This is the one that means work may start.", "completedAt, signedDocumentSha256"],
  "agreement.declined": ["A signer declined.", "declinedAt, declinedBy, reason"],
  "agreement.voided": ["The request was cancelled or replaced.", "voidedAt, reason"],
  "agreement.expired": ["The request ran out of time unsigned.", "expiredAt"],
};

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minutes` : ""}`;
}

const NAV: { href: string; label: string; children?: { href: string; label: string }[] }[] = [
  { href: "#overview", label: "Overview" },
  { href: "#authentication", label: "Authentication" },
  { href: "#quick-start", label: "Five-minute quick start" },
  {
    href: "#files",
    label: "Files",
    children: [
      { href: "#create-file", label: "Create a file" },
      { href: "#list-files", label: "List files" },
      { href: "#get-file", label: "Get a file" },
      { href: "#update-file", label: "Change a file" },
      { href: "#send-agreement", label: "Send the agreement" },
      { href: "#archive-file", label: "Archive a file" },
    ],
  },
  { href: "#agreements", label: "Agreements" },
  {
    href: "#envelopes",
    label: "Envelopes",
    children: [
      { href: "#get-envelope", label: "Get an envelope" },
      { href: "#void-envelope", label: "Void an envelope" },
      { href: "#remind", label: "Send a reminder" },
      { href: "#download", label: "Download the PDF" },
    ],
  },
  { href: "#me", label: "Check a key" },
  { href: "#statuses", label: "Statuses" },
  { href: "#errors", label: "Errors" },
  { href: "#idempotency", label: "Idempotency" },
  { href: "#rate-limits", label: "Rate limits" },
  { href: "#webhooks", label: "Webhooks" },
  { href: "#typical-integration", label: "A typical integration" },
];

function Contents({ className }: { className?: string }) {
  const link = "block rounded-sm py-1 text-sm text-ink-soft hover:text-ink";
  return (
    <ul className={className}>
      {NAV.map((item) => (
        <li key={item.href}>
          <a href={item.href} className={link}>
            {item.label}
          </a>
          {item.children ? (
            <ul className="mb-1 ml-3 border-l border-rule pl-3">
              {item.children.map((child) => (
                <li key={child.href}>
                  <a href={child.href} className={link}>
                    {child.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function ApiReferencePage() {
  const base = env.appUrl;
  const ids = EXAMPLE_IDS;
  const idempotencyHours = IDEMPOTENCY_WINDOW_SECONDS / 3600;
  const retryWaits = Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) => minutes(webhookRetryDelayMs(i + 1)));

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14 lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-12">
      <nav aria-label="On this page" className="hidden lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pr-2">
          <p className="text-sm font-semibold text-ink">On this page</p>
          <Contents className="mt-2" />
        </div>
      </nav>

      <main className={`min-w-0 ${prose}`}>
        <header>
          <h1 className="font-serif text-[34px] leading-[1.1] font-semibold text-ink sm:text-[42px]">API reference</h1>
          <p className="!mt-4 max-w-[62ch] text-[17px]">
            When a case or a deal is opened in the system you already use, that system can create the file in {PRODUCT_NAME}. The client
            agreement then goes out for signature by itself, and your system is told when it is signed.
          </p>
        </header>

        <details className="mt-6 rounded-md border border-rule bg-paper px-4 py-3 lg:hidden">
          <summary className="cursor-pointer text-sm font-semibold text-ink">On this page</summary>
          <Contents className="mt-2" />
        </details>

        <div className="mt-10 space-y-12">
          <Section id="overview" title="Overview">
            <p>
              The API is plain HTTPS and JSON. Every address starts with <code>{base}/api/v1</code>. Requests and responses use{" "}
              <code>snake_case</code> names, times are ISO 8601 in UTC, and a value that is not set is <code>null</code> rather than left
              out, so a response always has the same keys.
            </p>
            <p>Three things are worth knowing before the detail:</p>
            <ul>
              <li>
                A <strong>file</strong> is one job or case for one client. Creating a file sends your company&rsquo;s default agreement,
                unless you ask it not to.
              </li>
              <li>
                An <strong>envelope</strong> is one signing request for one file: the agreement exactly as it was when sent, the people
                who sign it, and where each of them stands. A file can have several over time; at most one is open.
              </li>
              <li>
                An <strong>agreement</strong> is the document your company uploaded and set up in {PRODUCT_NAME}. Agreements are managed
                on screen, not through the API; the API lets you list them and choose one.
              </li>
            </ul>
            <p>
              The API is for your server to call. It does not send CORS headers, so it cannot be called from a web page in a browser, and
              an API key must never be put in one.
            </p>
            <p>
              Request bodies are limited to {MAX_BODY_BYTES / 1024} KB. A field or query parameter the API does not know is refused, with
              a message naming it, instead of being ignored: a misspelled <code>client_email</code> should fail on the first day, not go
              unnoticed for a month.
            </p>
          </Section>

          <Section id="authentication" title="Authentication">
            <p>
              An owner or admin creates a key under <Link href="/settings/developers">Settings, Developers</Link>. The key is shown once.
              Send it with every request:
            </p>
            <Code label="The header every request needs">{`Authorization: Bearer ${EXAMPLE_KEY}`}</Code>
            <p>
              A key acts for the whole company and sees only that company&rsquo;s files. A request with no key, or a key that is
              mistyped or has been revoked, is answered with <code>401</code> and a <code>WWW-Authenticate: Bearer</code> header.
              Revoking a key takes effect at once. Use one key per system, so that one can be replaced without touching the others.
            </p>
          </Section>

          <Section id="quick-start" title="Five-minute quick start">
            <p>
              Before you start, make sure an agreement is uploaded and active in {PRODUCT_NAME}, and create an API key. Replace{" "}
              <code>{EXAMPLE_KEY}</code> below with your key.
            </p>
            <ol>
              <li>
                <strong>Check the key.</strong> The answer names your company and says whether an agreement is ready to send.
                <Code label="Request">{curl(base, "GET", "/me")}</Code>
              </li>
              <li>
                <strong>Create a file.</strong> Use an address you can read mail at. The agreement is sent in the same request.
                <Code label="Request">{curl(base, "POST", "/files", EXAMPLE_BODIES.quickStart)}</Code>
                <Code label="Response, 201 Created">{pretty(EXAMPLE_RESPONSES.createFile)}</Code>
              </li>
              <li>
                <strong>Sign it.</strong> Open the email, or open <code>agreement.signing_url</code> from the response, and sign as the
                client would.
              </li>
              <li>
                <strong>See that the file is cleared.</strong> <code>cleared_to_start</code> is now <code>true</code>.
                <Code label="Request">{curl(base, "GET", `/files/${ids.file}`)}</Code>
              </li>
              <li>
                <strong>Download the signed copy.</strong>
                <Code label="Request">{`${curl(base, "GET", `/envelopes/${ids.envelope}/document`)} \\\n  -o signed-agreement.pdf`}</Code>
              </li>
            </ol>
            <p>
              If your company also signs the agreement, step 4 shows <code>awaiting_countersign</code> until your signer has signed on
              screen (or straight away, if automatic countersigning is switched on in settings).
            </p>
          </Section>

          <Section id="files" title="Files">
            <p>The file object, as it appears in every response that contains one:</p>
            <Params
              level={3}
              title="Fields"
              items={[
                { name: "id", type: "string", children: "The id to use in addresses." },
                { name: "reference", type: "string", children: "Your file number, as people see it. Unique in your company, whatever the letter case." },
                { name: "external_id", type: "string or null", children: "The id of this case in your own system, if you sent one." },
                { name: "client_name, client_email", type: "string", children: "Who signs." },
                { name: "client_company, client_title, client_phone, description", type: "string or null", children: "Optional details." },
                { name: "data", type: "object", children: "Your own extra values, used to fill blanks in the agreement. Values are stored as text." },
                { name: "source", type: "string", children: <>How the file was created: <code>api</code>, <code>manual</code>, <code>csv</code> or <code>intake</code>.</> },
                { name: "agreement_status", type: "string", children: <>Where the agreement stands. See <a href="#statuses">Statuses</a>.</> },
                { name: "cleared_to_start", type: "boolean", children: <>True only when <code>agreement_status</code> is <code>signed</code>. This is the gate to build on.</> },
                { name: "archived_at, created_at, updated_at", type: "time", children: <><code>archived_at</code> is null for a current file.</> },
              ]}
            />

            <Endpoint id="create-file" method="POST" path="/api/v1/files" title="Create a file">
              <p>
                Creates the file and sends the default agreement. The answer has three parts: the <code>file</code>, whether it was{" "}
                <code>created</code> by this request, and <code>agreement</code>, which says what happened to the agreement.
              </p>
              <Params
                title="Body"
                items={[
                  { name: "client_name", type: "string", required: true, children: `The person who signs. Up to ${FILE_LIMITS.clientNameMax} characters.` },
                  { name: "client_email", type: "string", required: true, children: "Where the signing request is sent." },
                  { name: "client_company", type: "string", children: `Up to ${FILE_LIMITS.clientCompanyMax} characters.` },
                  { name: "client_title", type: "string", children: `Up to ${FILE_LIMITS.clientTitleMax} characters.` },
                  { name: "client_phone", type: "string", children: `Up to ${FILE_LIMITS.clientPhoneMax} characters.` },
                  { name: "description", type: "string", children: `What the work is. Up to ${FILE_LIMITS.descriptionMax} characters.` },
                  { name: "reference", type: "string", children: `Your file number, up to ${FILE_LIMITS.referenceMax} characters. One is generated when you leave it out. A reference already in use is refused with 409.` },
                  {
                    name: "external_id",
                    type: "string",
                    children: (
                      <>
                        The id of this case in your system, up to {FILE_LIMITS.externalIdMax} characters. <strong>Send it.</strong> Creating
                        again with the same value returns the first file and sends nothing, which makes retries safe.
                      </>
                    ),
                  },
                  { name: "data", type: "object", children: `Up to ${FILE_LIMITS.dataMaxKeys} names with text, number or true/false values, for blanks in the agreement such as a matter name or a fee.` },
                  { name: "send", type: "boolean", children: "false creates the file without sending. true sends even if automatic sending is switched off in settings. Left out, your company's setting decides." },
                ]}
              />
              <Code label="Request">{curl(base, "POST", "/files", EXAMPLE_BODIES.createFile, ["Idempotency-Key: 5f0c2a6e-8a53-4c0e-9d0b-2f3f6f1f7a10"])}</Code>
              <Code label="Response, 201 Created">{pretty(EXAMPLE_RESPONSES.createFile)}</Code>
              <Params
                title="The agreement part of the answer"
                items={[
                  { name: "sent", type: "boolean", children: "True when this request created a signing request." },
                  { name: "envelope_id", type: "string or null", children: "The signing request. Keep it: it is how you download the signed PDF later." },
                  { name: "delivery", type: "string or null", children: <>How the client was told. Anything other than <code>emailed</code> means the client has not been emailed. See <a href="#statuses">Statuses</a>.</> },
                  { name: "delivery_note", type: "string or null", children: "When the client was not emailed: why, and what to do, in words you can show a person." },
                  { name: "signing_url", type: "string or null", children: "The client's own signing link. Treat it like the document itself. It is returned so your staff can pass it on when the email did not go." },
                  { name: "reason", type: "string or null", children: "When sent is false: why. For example no agreement is active yet, or sending was switched off." },
                ]}
              />
              <p>
                The file is created even when the agreement cannot be sent. The status is still <code>201</code>;{" "}
                <code>agreement.sent</code> is <code>false</code> and <code>agreement.reason</code> says why. When the email could not go
                but the request exists, it looks like this:
              </p>
              <Code label="Response when the client was not emailed (agreement part)">{pretty({ agreement: EXAMPLE_RESPONSES.createFileNotEmailed.agreement })}</Code>
              <p>
                When a file with the same <code>external_id</code> already exists the status is <code>200</code>, <code>created</code> is{" "}
                <code>false</code>, and <code>agreement</code> describes the request already on that file, with its link.
              </p>
            </Endpoint>

            <Endpoint id="list-files" method="GET" path="/api/v1/files" title="List files">
              <p>Newest first. Archived files are left out unless you ask for them.</p>
              <Params
                title="Query"
                items={[
                  { name: "status", type: "string", children: <>One or more of {AGREEMENT_STATUSES.map((s, i) => <span key={s}>{i ? ", " : ""}<code>{s}</code></span>)}, separated by commas.</> },
                  { name: "q", type: "string", children: "Words to look for in the client's name, email, company and the file reference. Every word must appear." },
                  { name: "archived", type: "string", children: <><code>false</code> (the default), <code>true</code> for archived files only, or <code>all</code>.</> },
                  { name: "page", type: "number", children: "Starts at 1. A page past the end is an empty list." },
                  { name: "per_page", type: "number", children: `1 to ${FILE_LIMITS.pageSizeMax}. The default is ${FILE_LIMITS.pageSizeDefault}.` },
                ]}
              />
              <Code label="Request">{curl(base, "GET", "/files?status=out_for_signature,awaiting_countersign&per_page=50")}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.listFiles)}</Code>
              <p>
                To read everything, follow <code>next_page</code> until it is <code>null</code>. To find one file by the id in your own
                system, repeat the create request with its <code>external_id</code>: it returns the existing file without changing it.
              </p>
            </Endpoint>

            <Endpoint id="get-file" method="GET" path="/api/v1/files/{id}" title="Get a file">
              <p>
                The file with every envelope sent for it, newest first. Each signer who can still sign has a <code>signing_url</code>;
                the link of your company&rsquo;s own signer is never given to an API key and is always <code>null</code>.
              </p>
              <Code label="Request">{curl(base, "GET", `/files/${ids.file}`)}</Code>
              <Code label="Response, 200 OK, once everyone has signed">{pretty(EXAMPLE_RESPONSES.getFileSigned)}</Code>
            </Endpoint>

            <Endpoint id="update-file" method="PATCH" path="/api/v1/files/{id}" title="Change a file">
              <p>
                Send only what changes; anything left out stays as it is, and <code>null</code> clears an optional value.{" "}
                <code>data</code>, when sent, replaces all the extra values. <code>external_id</code> cannot be changed.
              </p>
              <Params
                title="Body"
                items={[
                  { name: "client_name, client_email, reference", type: "string", children: "Cannot be emptied." },
                  { name: "client_company, client_title, client_phone, description", type: "string or null", children: "null clears the value." },
                  { name: "data", type: "object or null", children: "Replaces every extra value." },
                ]}
              />
              <Code label="Request">{curl(base, "PATCH", `/files/${ids.file}`, EXAMPLE_BODIES.updateFile)}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.updateFile)}</Code>
              <p>
                Changing a file never changes an agreement that is already out. When the client&rsquo;s name or email changed while they
                still have to sign, <code>reissue_suggested</code> is <code>true</code>: the request they hold carries the old details.{" "}
                <a href="#send-agreement">Send the agreement</a> again with <code>replace</code> to issue a corrected one.
              </p>
            </Endpoint>

            <Endpoint id="send-agreement" method="POST" path="/api/v1/files/{id}/send" title="Send the agreement">
              <p>
                For a file that has nothing out for signature: one created with <code>send: false</code>, or one whose request was
                declined, voided or expired. If a request is already open the answer is <code>409</code>, so an accidental second call
                cannot send the client two agreements.
              </p>
              <Params
                title="Body (all optional)"
                items={[
                  { name: "agreement_id", type: "string", children: <>Send this agreement instead of the default one. Ids come from <a href="#agreements">List agreements</a>.</> },
                  { name: "replace", type: "boolean", children: "true voids the request that is open and sends a new one. Also needed to send again on a file that is already signed." },
                  { name: "replace_envelope_id", type: "string", children: "With replace: the envelope you mean to replace. A repeat of the same request then returns the replacement instead of replacing it again." },
                  { name: "replace_signed", type: "boolean", children: "With replace: also discard a request the client has already signed and that is waiting for your company's signature." },
                ]}
              />
              <Code label="Request, choosing an agreement">{curl(base, "POST", `/files/${ids.file}/send`, EXAMPLE_BODIES.send)}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.send)}</Code>
              <Code label="Request, replacing the one that is out">{curl(base, "POST", `/files/${ids.file}/send`, EXAMPLE_BODIES.resend)}</Code>
            </Endpoint>

            <Endpoint id="archive-file" method="POST" path="/api/v1/files/{id}/archive" title="Archive a file">
              <p>
                For work that is finished or will not happen. The file leaves the working lists and any request still out for signature
                is voided, so the client cannot sign for it. Nothing is deleted. Archiving an archived file changes nothing. Send no
                body.
              </p>
              <Code label="Request">{curl(base, "POST", `/files/${ids.file}/archive`)}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.archive)}</Code>
            </Endpoint>
          </Section>

          <Section id="agreements" title="Agreements">
            <Endpoint id="list-agreements" method="GET" path="/api/v1/agreements" title="List agreements">
              <p>
                The agreements your company has set up, so an integration can offer a choice or send a particular one. Only an agreement
                with <code>ready: true</code> can be sent; otherwise <code>problems</code> says what is missing. Add{" "}
                <code>?include_archived=true</code> to see archived ones too.
              </p>
              <Code label="Request">{curl(base, "GET", "/agreements")}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.agreements)}</Code>
            </Endpoint>
          </Section>

          <Section id="envelopes" title="Envelopes">
            <p>
              An envelope keeps the agreement exactly as it was when sent. Editing the agreement afterwards never changes what a client
              was asked to sign.
            </p>
            <Params
              level={3}
              title="Fields"
              items={[
                { name: "id, file_id", type: "string", children: "The envelope and the file it belongs to." },
                { name: "agreement_id, agreement_name, agreement_version", type: "string, string, number", children: "Which agreement was sent, and which version of it." },
                { name: "status", type: "string", children: <>See <a href="#statuses">Statuses</a>.</> },
                { name: "sent_at, completed_at, expires_at", type: "time or null", children: `Unsigned requests expire after ${ORG_SETTING_DEFAULTS.expireAfterDays} days unless your company chose another period.` },
                { name: "decline_reason, void_reason", type: "string or null", children: "Set when the envelope was declined or voided." },
                { name: "original_sha256, signed_sha256", type: "string, string or null", children: "SHA-256 of the unsigned PDF and of the sealed copy. The second is null until everyone has signed." },
                { name: "reminder_count", type: "number", children: "Automatic reminders sent so far." },
                { name: "signers", type: "list", children: <>In signing order. Each has <code>id</code>, <code>role</code> (<code>client</code> or <code>company</code>), <code>name</code>, <code>email</code>, <code>status</code>, <code>viewed_at</code>, <code>signed_at</code> and <code>signing_url</code>.</> },
              ]}
            />

            <Endpoint id="get-envelope" method="GET" path="/api/v1/envelopes/{id}" title="Get an envelope">
              <Code label="Request">{curl(base, "GET", `/envelopes/${ids.envelope}`)}</Code>
              <Code label="Response, 200 OK, while waiting for the client">{pretty(EXAMPLE_RESPONSES.getEnvelope)}</Code>
            </Endpoint>

            <Endpoint id="void-envelope" method="POST" path="/api/v1/envelopes/{id}/void" title="Void an envelope">
              <p>
                Cancels a request that is still open. Its links stop working at once and the signers are told. Voiding a voided envelope
                changes nothing; a completed, declined or expired one cannot be voided (<code>409</code>).
              </p>
              <Params
                title="Body (all optional)"
                items={[
                  { name: "reason", type: "string", children: "Why, up to 500 characters. Shown on the file and to the signers." },
                  { name: "include_signed", type: "boolean", children: "Needed to void a request the client has already signed. Without it that is refused with 409, so a cancel meant for an unsigned request cannot throw a signature away." },
                ]}
              />
              <Code label="Request">{curl(base, "POST", `/envelopes/${ids.envelope}/void`, EXAMPLE_BODIES.voidEnvelope)}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.voidEnvelope)}</Code>
            </Endpoint>

            <Endpoint id="remind" method="POST" path="/api/v1/envelopes/{id}/remind" title="Send a reminder">
              <p>
                Emails whoever the envelope is waiting on, now. Automatic reminders go out anyway (every{" "}
                {ORG_SETTING_DEFAULTS.reminderEveryDays} days, up to {ORG_SETTING_DEFAULTS.maxReminders} times, unless your company
                changed that); this is for when someone asks. More than a few in an hour for the same envelope is refused with{" "}
                <code>429</code>. Send no body.
              </p>
              <Code label="Request">{curl(base, "POST", `/envelopes/${ids.envelope}/remind`)}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.remind)}</Code>
            </Endpoint>

            <Endpoint id="download" method="GET" path="/api/v1/envelopes/{id}/document" title="Download the PDF">
              <p>
                Answers with the PDF itself (<code>Content-Type: application/pdf</code>), not JSON.
              </p>
              <Params
                title="Query"
                items={[
                  { name: "kind", type: "string", children: <><code>signed</code> (the default): the sealed copy with its audit certificate. It exists once everyone has signed; before that the answer is <code>409</code> with code <code>not_ready</code>. <code>original</code>: the unsigned agreement exactly as it was sent.</> },
                ]}
              />
              <Code label="Request">{`${curl(base, "GET", `/envelopes/${ids.envelope}/document?kind=signed`)} \\\n  -o signed-agreement.pdf`}</Code>
              <p>
                The <code>X-Signgate-Sha256</code> response header is the SHA-256 of the bytes sent. For the signed copy it equals the
                envelope&rsquo;s <code>signed_sha256</code>, and anyone can check a copy against it on the{" "}
                <Link href="/verify">verification page</Link>.
              </p>
            </Endpoint>
          </Section>

          <Section id="me" title="Check a key">
            <Endpoint id="get-me" method="GET" path="/api/v1/me" title="Which company is this key for?">
              <p>
                The connectivity test. <code>default_agreement</code> is the agreement that creating a file would send, or{" "}
                <code>null</code> when none is active; if it is there but <code>ready</code> is <code>false</code>,{" "}
                <code>problems</code> says what to fix on screen first.
              </p>
              <Code label="Request">{curl(base, "GET", "/me")}</Code>
              <Code label="Response, 200 OK">{pretty(EXAMPLE_RESPONSES.me)}</Code>
            </Endpoint>
          </Section>

          <Section id="statuses" title="Statuses">
            <h3 className="mt-5 text-base font-semibold text-ink">A file&rsquo;s agreement_status</h3>
            <RefTable caption="File agreement statuses" head={["Value", "Meaning"]} rows={AGREEMENT_STATUSES.map((s) => [<code key={s}>{s}</code>, FILE_STATUS_MEANING[s]])} />
            <h3 className="mt-6 text-base font-semibold text-ink">An envelope&rsquo;s status</h3>
            <RefTable caption="Envelope statuses" head={["Value", "Meaning"]} rows={ENVELOPE_STATUS_MEANING.map(([s, m]) => [<code key={s}>{s}</code>, m])} />
            <p>
              A signer&rsquo;s own <code>status</code> is <code>waiting</code> (not their turn yet), <code>sent</code>, <code>viewed</code>,{" "}
              <code>signed</code> or <code>declined</code>.
            </p>
            <h3 className="mt-6 text-base font-semibold text-ink">delivery</h3>
            <RefTable caption="Delivery outcomes" head={["Value", "Meaning"]} rows={DELIVERY_MEANING.map(([s, m]) => [<code key={s}>{s}</code>, m])} />
          </Section>

          <Section id="errors" title="Errors">
            <p>
              Every error has the same shape. <code>message</code> is written for a person and says what to do next;{" "}
              <code>code</code> is for your program; <code>fields</code>, when present, names each part of the request that was wrong.
            </p>
            <Code label="Response, 422 Unprocessable Content">
              {pretty(EXAMPLE_ERROR)}
            </Code>
            <RefTable
              caption="Error codes"
              head={["Status", "code", "Meaning"]}
              rows={Object.entries(API_ERROR_CODES).map(([code, { status, meaning }]) => [String(status), <code key={code}>{code}</code>, meaning.replace(/`/g, "")])}
            />
            <p>
              An id that belongs to another company is answered exactly like an id that does not exist: <code>404</code>. After a{" "}
              <code>500</code>, or no answer at all, repeat the request with the same <code>Idempotency-Key</code>.
            </p>
          </Section>

          <Section id="idempotency" title="Idempotency">
            <p>Networks fail halfway. Two things make it safe to send a request again without a client receiving two agreements.</p>
            <ul>
              <li>
                <strong>
                  <code>external_id</code> on files.
                </strong>{" "}
                Creating a file with an <code>external_id</code> that already exists returns the existing file with{" "}
                <code>created: false</code> and sends nothing. It has no time limit. If you do one thing, do this.
              </li>
              <li>
                <strong>
                  The <code>Idempotency-Key</code> header.
                </strong>{" "}
                Any <code>POST</code> accepts one: a value you make up per action, such as a UUID, up to {IDEMPOTENCY_KEY_MAX_LENGTH}{" "}
                characters. For {idempotencyHours} hours, a second request to the same address with the same key is not carried out
                again.
              </li>
            </ul>
            <p>
              The answer to a repeat describes how things stand now and carries the header <code>Idempotent-Replayed: true</code>. For
              sending, that is the agreement on the file with <code>sent: false</code>; for a reminder,{" "}
              <code>reminded: false</code>. It is not a stored copy of the first answer.
            </p>
            <p>
              Two cases answer <code>409</code> with code <code>idempotency_key_reused</code>: the key was used before with a different
              body, or a file was created without an <code>external_id</code> and the request is repeated, where there is no reliable
              way to find the first file. A request refused with a 4xx error changed nothing, so its key can be used again once the
              request is corrected.
            </p>
          </Section>

          <Section id="rate-limits" title="Rate limits">
            <p>
              Each key may make {API_RATE_LIMIT.requests} requests every {API_RATE_LIMIT.windowSeconds} seconds. Past that the answer is{" "}
              <code>429</code> with a <code>Retry-After</code> header giving the number of seconds to wait.
            </p>
            <p>
              Sending has limits of its own, to protect the people who receive the emails: {SEND_LIMITS.perHour.toLocaleString("en-US")}{" "}
              signing requests an hour and {SEND_LIMITS.perDay.toLocaleString("en-US")} a day for a company (
              {SEND_LIMITS.newOrgPerHour.toLocaleString("en-US")} and {SEND_LIMITS.newOrgPerDay.toLocaleString("en-US")} in its first{" "}
              {SEND_LIMITS.newOrgDays} days), {SEND_LIMITS.perFilePerHour} an hour for one file, and {SEND_LIMITS.perRecipientPerDay} a
              day to one email address. When one of these stops a create request, the file is still created and{" "}
              <code>agreement.reason</code> explains; on the send and remind endpoints the answer is <code>429</code>.
            </p>
          </Section>

          <Section id="webhooks" title="Webhooks">
            <p>
              A webhook is an address on your server that {PRODUCT_NAME} posts to when something happens, so you do not have to keep
              asking. An owner or admin adds one under <Link href="/settings/developers">Settings, Developers</Link> (up to{" "}
              {MAX_WEBHOOKS_PER_ORG}). The signing secret is shown once, when the webhook is added. Every webhook receives every event.
            </p>
            <RefTable
              caption="Webhook events"
              head={["Event", "When", "Extra keys in data"]}
              rows={WEBHOOK_EVENTS.map((e) => [<code key={e}>{e}</code>, EVENT_MEANING[e][0], EVENT_MEANING[e][1]])}
            />
            <p>
              Each delivery is a <code>POST</code> with a JSON body and these headers: <code>X-Signgate-Event</code>,{" "}
              <code>X-Signgate-Delivery</code> (the same as <code>id</code> in the body, and the same on every retry, so use it to
              ignore duplicates) and <code>X-Signgate-Signature</code>.
            </p>
            <Code label="Body of an agreement.completed delivery">{pretty(EXAMPLE_WEBHOOKS.completed)}</Code>
            <p>
              Every <code>agreement.*</code> event has the keys shown above in <code>data</code>, plus the extra ones in the table.
              Note that the names inside <code>data</code> are <code>camelCase</code>, unlike the rest of the API. The signing link is
              never in a webhook; fetch the file when you need it. <code>file.created</code> carries the whole file:
            </p>
            <Code label="Body of a file.created delivery">{pretty(EXAMPLE_WEBHOOKS.fileCreated)}</Code>

            <h3 className="mt-6 text-base font-semibold text-ink">Check the signature</h3>
            <p>
              Anyone can post to your address, so check that a delivery really came from {PRODUCT_NAME}. The header looks like{" "}
              <code>t=1763371904,v1=5f2c&hellip;</code>: <code>t</code> is the time it was signed, in seconds, and <code>v1</code> is
              the HMAC-SHA256, in hex, of <code>t</code>, a full stop and the raw body, keyed with your webhook&rsquo;s secret. Compute
              the same value and compare. Use the body exactly as it arrived, before parsing it, and refuse anything older than five
              minutes.
            </p>
            <Code label="Node.js">{VERIFY_NODE}</Code>
            <Code label="Python">{VERIFY_PYTHON}</Code>

            <h3 className="mt-6 text-base font-semibold text-ink">Answering, and retries</h3>
            <p>
              Answer with any <code>2xx</code> status within {WEBHOOK_TIMEOUT_MS / 1000} seconds; do slow work afterwards. Anything
              else, including a redirect, counts as a failure. A failed delivery is tried again, up to {WEBHOOK_MAX_ATTEMPTS} attempts
              in all, waiting at least {retryWaits.slice(0, -1).join(", ")} and then {retryWaits.at(-1)} between them. Retries are sent
              in batches, so one can arrive up to {TICK_INTERVAL_SECONDS / 60} minutes later than that, or later still on a quiet
              deployment. After the last attempt the delivery is marked failed and is listed, with the reason, in settings. Events can
              arrive out of order; trust <code>status</code> in the newest one, or fetch the file.
            </p>
          </Section>

          <Section id="typical-integration" title="A typical integration">
            <p>What a case-management system usually does, start to finish:</p>
            <ol>
              <li>
                <strong>When a case is opened</strong>, call <a href="#create-file">Create a file</a> with the client&rsquo;s name and
                email and your case id as <code>external_id</code>. Store <code>file.id</code> and <code>agreement.envelope_id</code>{" "}
                against the case.
              </li>
              <li>
                <strong>Look at the answer.</strong> If <code>agreement.sent</code> is <code>false</code>, or{" "}
                <code>agreement.delivery</code> is not <code>emailed</code>, show <code>reason</code> or <code>delivery_note</code> to
                the person who opened the case; with a <code>signing_url</code> they can pass the link on themselves.
              </li>
              <li>
                <strong>Wait for the signature.</strong> Add a webhook and act on <code>agreement.completed</code>: check the
                signature, then mark the case as cleared to start. Without webhooks, ask for{" "}
                <code>GET /api/v1/files?status=signed</code> every few minutes instead, or read <code>cleared_to_start</code> on the
                file before work begins.
              </li>
              <li>
                <strong>Keep the signed copy.</strong> <a href="#download">Download the PDF</a> for the envelope and store it with the
                case.
              </li>
              <li>
                <strong>When the client&rsquo;s details change</strong>, <a href="#update-file">change the file</a>. If{" "}
                <code>reissue_suggested</code> comes back <code>true</code>, send again with <code>replace: true</code>.
              </li>
              <li>
                <strong>When a case is cancelled</strong>, <a href="#archive-file">archive the file</a>. Any request still out is
                voided for you.
              </li>
              <li>
                <strong>Handle <code>agreement.declined</code> and <code>agreement.expired</code></strong> by telling a person: these
                are the cases a program should not decide alone.
              </li>
            </ol>
          </Section>
        </div>
      </main>
    </div>
  );
}
