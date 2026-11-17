import type { Metadata } from "next";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/env";
import { ORG_SETTING_DEFAULTS } from "@/lib/types";
import { Article } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Security",
  description: `How ${PRODUCT_NAME} protects signing links, records who signed, makes signed agreements tamper-evident and keeps each company's files separate.`,
};

/*
 * Every statement on this page describes behaviour in src/lib/services, src/lib/auth,
 * src/lib/pdf or next.config.ts. If that behaviour changes, change this page in the
 * same commit. Do not add a claim here that the code does not back.
 */
export default function SecurityPage() {
  return (
    <Article
      title="Security"
      lead={`This page describes how ${PRODUCT_NAME} works today, in enough detail for you or your IT adviser to judge it. It lists what the product does and, at the end, what it does not do.`}
    >
      <h2>Signing links</h2>
      <p>
        Each person who has to sign gets their own link. The link contains a 256-bit secret, and that secret is the only thing that lets
        someone open the agreement, so a link should be treated like the document itself.
      </p>
      <ul>
        <li>
          <strong>The secret is not stored.</strong> The database holds only a SHA-256 hash of it. When a link arrives, it is hashed and
          looked up; a copy of the database would not reveal a working link.
        </li>
        <li>
          <strong>A link can be replaced.</strong> When a signer&rsquo;s name or email address is corrected a new link is issued and
          the old one stops working. A mistyped link and a replaced link get the same answer, so the page cannot be used to test
          guesses.
        </li>
        <li>
          <strong>A link stops accepting a signature</strong> once the agreement is signed, declined, cancelled or expired. Unsigned
          requests expire after {ORG_SETTING_DEFAULTS.expireAfterDays} days unless the company chooses a different period. After
          completion the same link lets the signer download their finished copy.
        </li>
        <li>
          <strong>Links are kept out of logs and search engines.</strong> Signing pages are served with instructions not to index or
          cache them and not to pass their address on to other sites, and the application does not write link secrets to its logs.
        </li>
        <li>
          <strong>Attempts are limited.</strong> Opening, signing and declining are rate-limited per link and per network address.
        </li>
      </ul>
      <p>
        A signing link proves that someone had access to the email it was sent to. {PRODUCT_NAME} does not check a signer&rsquo;s
        identity in any other way: there is no access code, text-message check or ID verification.
      </p>

      <h2>What is recorded when someone signs</h2>
      <p>
        Before a client can sign they must tick a box agreeing to sign electronically, with a link to the{" "}
        <Link href="/legal/esign-disclosure">electronic signature disclosure</Link>. For each signer the record then holds:
      </p>
      <ul>
        <li>their name and email address;</li>
        <li>when they consented and when they signed, to the second;</li>
        <li>the network (IP) address and browser the signature came from;</li>
        <li>how the signature was given: through an emailed link, by a signed-in team member, or applied automatically from a saved signature.</li>
      </ul>
      <p>
        What a signer types is checked on the server against the fields that belong to that signer. One party cannot fill in or
        change the other party&rsquo;s fields, and nobody can alter the agreement&rsquo;s text.
      </p>

      <h2>The audit trail</h2>
      <p>
        Every step in an agreement&rsquo;s life is written to the file&rsquo;s timeline: sent, opened, reminded, consented, signed,
        countersigned, declined, cancelled, expired and completed. The entry is saved in the same
        database transaction as the change it describes, so the two cannot disagree. The application only ever adds entries; it has
        no function that edits or removes one.
      </p>
      <p>
        Changes of state are guarded so that a double click, a retried request or two people acting at once cannot sign twice,
        complete an agreement twice or revive one that was cancelled.
      </p>

      <h2>Tamper evidence</h2>
      <p>
        When an agreement is sent, {PRODUCT_NAME} takes a copy of the document and its fields as they are at that moment and records
        the copy&rsquo;s SHA-256 fingerprint. Later edits to your template never change an agreement that is already out.
      </p>
      <p>
        When everyone has signed, the signatures are stamped onto that copy, a reference is printed on every page, and a signing
        certificate is appended listing the signers, the details above, the timeline and the fingerprint of the original. The finished
        PDF is then fingerprinted in turn and stored.
      </p>
      <p>
        Anyone holding a signed copy can check it on the <Link href="/verify">verify page</Link>. If the copy&rsquo;s fingerprint
        matches one on record, the page confirms which company sent it, the agreement&rsquo;s name, when it was completed and who
        signed, with email addresses partly hidden. If a single byte of the file has changed, there is no match.
      </p>
      <p>
        This is a fingerprint held by {PRODUCT_NAME}, not a certificate-based digital signature embedded in the PDF. A PDF reader will
        not show a signature panel, and verification depends on this service being reachable.
      </p>

      <h2>Keeping companies separate</h2>
      <p>
        Every company&rsquo;s agreements, files, signed documents, team members and settings are tagged with that company. Each
        request works out which company it belongs to from the signed-in session or the API key, never from anything the browser
        sends, and every database query is limited to that company. Asking for another company&rsquo;s record by its identifier
        returns &ldquo;not found&rdquo;.
      </p>
      <p>
        Inside a company there are three roles. Owners and admins manage agreements, settings, team members, API keys and webhooks;
        members work with files. Disabling a team member signs them out everywhere and cancels any countersignature link they held.
      </p>

      <h2>Accounts</h2>
      <ul>
        <li>Passwords are hashed with scrypt and a per-password random salt. They are never stored or logged in readable form.</li>
        <li>
          Sessions last 30 days. The session cookie cannot be read by scripts, is sent only over HTTPS in production, and only its hash
          is stored on the server. Changing or resetting a password ends every other session.
        </li>
        <li>
          Sign-in attempts are rate-limited, and the response does not reveal whether an email address has an account. Password reset
          links work once and expire after an hour; invitations expire after 7 days.
        </li>
        <li>
          A new company must confirm its owner&rsquo;s email address before {PRODUCT_NAME} will send email to clients in its name, and
          sending is capped per company, per file and per recipient.
        </li>
      </ul>

      <h2>API keys and webhooks</h2>
      <p>
        An API key is shown once, when it is created. Only its SHA-256 hash is kept, and a key can be revoked at any time. Each key
        belongs to one company and can reach only that company&rsquo;s data.
      </p>
      <p>
        Webhook notifications are signed with HMAC-SHA256 over a timestamp and the message, so the receiving system can confirm they
        came from {PRODUCT_NAME} and are recent. Webhook addresses that point to private or internal networks are refused, and
        redirects are not followed.
      </p>

      <h2>Where your data goes</h2>
      <ul>
        <li>
          <strong>Storage.</strong> Agreements, signed PDFs, signatures and the audit trail are stored in the service&rsquo;s Postgres
          database. Encryption at rest and backups are provided by the database host chosen by whoever operates this deployment.
        </li>
        <li>
          <strong>Email.</strong> Signing requests, reminders and completed copies are sent through an email provider. Those emails
          contain the recipient&rsquo;s name and address, the agreement&rsquo;s name and the signing link, and the completion email
          attaches the signed PDF when it is small enough to send.
        </li>
        <li>
          <strong>Field detection.</strong> When a company uploads an agreement, the blanks are found by rules that run inside the
          service. If the operator of this deployment has switched on AI-assisted detection, the uploaded template is also sent to
          Anthropic&rsquo;s API for that one purpose. Signed agreements and client details are not sent.
        </li>
        <li>
          <strong>Housekeeping.</strong> Expired sessions, used or expired account links and abandoned uploads are deleted
          automatically. Webhook delivery logs are kept for 30 days.
        </li>
      </ul>
      <p>
        Signed agreements and their audit trails are kept for as long as the company&rsquo;s account exists, because they are the
        company&rsquo;s records. Archiving a file hides it from the working list; it does not delete the signed agreement.
      </p>

      <h2>What {PRODUCT_NAME} does not do</h2>
      <ul>
        <li>It does not verify a signer&rsquo;s identity beyond delivery to their email address.</li>
        <li>It does not embed certificate-based (PKI) digital signatures in the PDF.</li>
        <li>It does not offer two-step sign-in or single sign-on for team accounts.</li>
        <li>It does not offer a self-service way to permanently delete a company&rsquo;s data; ask the operator.</li>
        <li>It holds no third-party security certification or audit report.</li>
      </ul>
      <p>If any of these is a requirement for your firm, check before relying on the service for those agreements.</p>

      <h2>Reporting a problem</h2>
      <p>
        If you believe you have found a security problem, or you received a signing request you did not expect, contact the company
        named in the email first. They can cancel the request, which disables the link immediately.
      </p>
    </Article>
  );
}
