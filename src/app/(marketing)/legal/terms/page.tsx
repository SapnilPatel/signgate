import type { Metadata } from "next";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/env";
import { Article } from "@/components/site/prose";
import { OperatorNotice } from "../operator-notice";

export const metadata: Metadata = {
  title: "Terms of service",
  description: `The starting terms for companies that use this ${PRODUCT_NAME} service.`,
};

export default function TermsPage() {
  return (
    <Article
      title="Terms of service"
      lead={`These terms are between the operator of this ${PRODUCT_NAME} service (“we”) and the company that creates an account (“you”). They are written to be read.`}
      updated="November 16, 2026"
      notice={<OperatorNotice document="terms" />}
    >
      <h2>1. The service</h2>
      <p>
        {PRODUCT_NAME} lets you upload your own agreement, send it to your clients for electronic signature, collect your
        countersignature, and store the signed copy with a record of how it was signed. We provide the tool. We are not a party to
        the agreements you send and we do not give legal advice.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>The person who creates the account confirms they are allowed to do so on the company&rsquo;s behalf.</li>
        <li>You are responsible for who you invite, what role you give them, and for removing people who leave.</li>
        <li>Keep passwords and API keys private. Tell us promptly if you think an account or key has been misused.</li>
      </ul>

      <h2>3. Your agreements and your clients</h2>
      <p>You are responsible for the documents you send and for your relationship with the people you send them to. In particular:</p>
      <ul>
        <li>the content of your agreement, and whether it is suitable to be signed electronically where you and your client are;</li>
        <li>sending requests only to people who expect them, at addresses they gave you;</li>
        <li>
          the wording your clients agree to before signing, including the{" "}
          <Link href="/legal/esign-disclosure">electronic signature disclosure</Link>, which you should have your own counsel review;
        </li>
        <li>keeping your own copies of signed agreements for as long as your profession or the law requires.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to use the service to:</p>
      <ul>
        <li>send unsolicited or deceptive requests, or impersonate another person or company;</li>
        <li>upload material you have no right to use, or anything unlawful;</li>
        <li>probe, overload or try to get around the service&rsquo;s security or sending limits;</li>
        <li>access another company&rsquo;s data.</li>
      </ul>
      <p>We may pause sending from, or suspend, an account that does any of these, and will tell the account owner when we do.</p>

      <h2>5. Your data</h2>
      <p>
        Your agreements, files and signed documents remain yours. We use them only to provide the service to you, as described in
        the <Link href="/legal/privacy">privacy notice</Link> and on the <Link href="/security">security page</Link>. You can download
        your signed agreements at any time while your account is open.
      </p>

      <h2>6. Availability and changes</h2>
      <p>
        We work to keep the service available and to send reminders and notifications on time, but we do not promise it will be
        uninterrupted or error-free. Email delivery in particular depends on other providers and on your client&rsquo;s mailbox. The
        files list is the authoritative record of what has and has not been signed.
      </p>
      <p>We may change or withdraw features. If a change materially reduces what you can do, we will give reasonable notice.</p>

      <h2>7. Liability</h2>
      <p>
        The service is provided as it is. To the extent the law allows, we are not liable for indirect or consequential loss,
        including lost profit or work that started or did not start because of an agreement&rsquo;s status. Nothing in these terms
        limits liability that cannot be limited by law.
      </p>

      <h2>8. Ending the arrangement</h2>
      <p>
        You can stop using the service at any time. We can end your access if you break these terms. Before closing your account,
        download the signed agreements you need to keep; ask us if you want your data deleted.
      </p>

      <h2>9. Changes to these terms</h2>
      <p>
        If we change these terms we will update the date at the top and, for significant changes, tell account owners by email.
        Continuing to use the service after a change means you accept it.
      </p>
    </Article>
  );
}
