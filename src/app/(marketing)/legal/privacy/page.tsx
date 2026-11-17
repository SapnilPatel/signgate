import type { Metadata } from "next";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/env";
import { Article } from "@/components/site/prose";
import { OperatorNotice } from "../operator-notice";

export const metadata: Metadata = {
  title: "Privacy notice",
  description: `What this ${PRODUCT_NAME} service collects about companies, their team members and the people who sign, and what it is used for.`,
};

export default function PrivacyPage() {
  return (
    <Article
      title="Privacy notice"
      lead={`This notice explains what information this ${PRODUCT_NAME} service holds, why, and who can see it. “We” means the operator of this service.`}
      updated="November 16, 2026"
      notice={<OperatorNotice document="privacy notice" />}
    >
      <h2>Two kinds of people use this service</h2>
      <p>
        <strong>Companies and their team members</strong> create accounts, upload agreements and open files. For their account
        details we decide how the information is used.
      </p>
      <p>
        <strong>Signers</strong> are the companies&rsquo; clients, who receive a link and sign. A signer&rsquo;s information is
        collected on behalf of the company that sent the request, and that company decides what happens to it. If you are a signer
        with a question or a request about your information, contact the company named on your signing page.
      </p>

      <h2>What is collected</h2>
      <h3>From companies and team members</h3>
      <ul>
        <li>Company name, and optionally its legal name, logo, colour and reply-to address.</li>
        <li>Each team member&rsquo;s name, work email address, job title if given, role and a hash of their password.</li>
        <li>A saved signature image, if a team member chooses to store one for countersigning.</li>
        <li>The agreements uploaded, the files opened, and the settings chosen.</li>
        <li>The network (IP) address and browser of the person performing actions that are written to the audit trail.</li>
      </ul>
      <h3>About signers</h3>
      <ul>
        <li>Name and email address, and any other client details the company enters on the file, such as a company name or title.</li>
        <li>Whatever the signer types into the agreement, and their signature.</li>
        <li>When they opened the agreement, consented and signed, and the network (IP) address and browser they used.</li>
      </ul>
      <p>
        The service does not use advertising or analytics trackers. The only cookie it sets is the one that keeps a team member
        signed in. Signing through an emailed link does not need a cookie.
      </p>

      <h2>What it is used for</h2>
      <ul>
        <li>Sending agreements, reminders and completed copies, and showing each file&rsquo;s status to the company.</li>
        <li>
          Producing the signing certificate attached to each signed agreement, which is the evidence that the signature is genuine.
        </li>
        <li>Keeping accounts secure: signing people in, limiting repeated attempts, and telling account owners about problems.</li>
      </ul>
      <p>Information is not sold, and is not used to advertise to companies or to signers.</p>

      <h2>Who can see it</h2>
      <ul>
        <li>
          <strong>The company&rsquo;s own team.</strong> Each company sees only its own files, agreements and signers.
        </li>
        <li>
          <strong>The other signers of the same agreement.</strong> Everyone who signs receives the completed document, including its
          certificate.
        </li>
        <li>
          <strong>Anyone who holds a signed copy.</strong> The <Link href="/verify">verify page</Link> will confirm a signed
          document&rsquo;s company, agreement name, completion date and signers&rsquo; names, with email addresses partly hidden,
          but only to someone who already has the exact file.
        </li>
        <li>
          <strong>Providers the service runs on.</strong> A hosting provider, a database provider and an email provider process the
          data in order to run the service. If AI-assisted field detection is switched on for this deployment, uploaded agreement
          templates, not signed agreements, are sent to Anthropic to locate their blanks.
        </li>
        <li>
          <strong>Systems the company connects.</strong> If a company sets up the API or webhooks, file and signing status is sent to
          the systems it names.
        </li>
      </ul>

      <h2>How long it is kept</h2>
      <p>
        Signed agreements, their certificates and audit trails are kept for as long as the company&rsquo;s account exists, because
        they are the company&rsquo;s business records. Expired sessions, used or expired account links and abandoned uploads are
        deleted automatically, and webhook delivery logs are kept for 30 days.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Team members can change their name, password and saved signature from their account page.</li>
        <li>Owners and admins can remove team members and revoke API keys.</li>
        <li>
          Signers can decline to sign electronically; see the{" "}
          <Link href="/legal/esign-disclosure">electronic signature disclosure</Link>. Requests to see, correct or delete a
          signer&rsquo;s information go to the company that sent the agreement.
        </li>
        <li>Companies that want their account and data deleted should ask the operator of this service.</li>
      </ul>

      <h2>Security</h2>
      <p>
        How signing links, passwords, signed documents and the separation between companies work is described on the{" "}
        <Link href="/security">security page</Link>.
      </p>

      <h2>Changes to this notice</h2>
      <p>If this notice changes, the date at the top will change, and account owners will be told by email about significant changes.</p>
    </Article>
  );
}
