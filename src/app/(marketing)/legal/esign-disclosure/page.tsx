import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/env";
import { Article } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Electronic records and signatures disclosure",
  description: "What it means to agree to receive and sign a document electronically, how to get a paper copy and how to withdraw your consent.",
};

// The signing page's consent tick box and the signing emails link to this URL. Keep the path stable.
export default function EsignDisclosurePage() {
  return (
    <Article
      title="Electronic records and signatures disclosure"
      lead="You have been asked to sign a document electronically. Please read this before you tick the box agreeing to do so. “The sender” means the company that sent you the signing request and is named at the top of the signing page."
      updated="November 16, 2026"
      notice={
        <p>
          <strong>For companies using {PRODUCT_NAME}:</strong> this is general wording provided as a starting point. It is not legal
          advice and has not been reviewed for your jurisdiction, industry or agreement. Have your own counsel review it before you
          rely on it, particularly if you deal with consumers or are in a regulated field such as lending or insurance.
        </p>
      }
    >
      <h2>What you are agreeing to</h2>
      <p>By ticking the box on the signing page and signing, you agree that:</p>
      <ul>
        <li>the sender may give you this document, and the completed copy of it, in electronic form instead of on paper;</li>
        <li>your electronic signature on this document has the same effect as a signature written by hand;</li>
        <li>you have been able to open and read the document on the device you are using.</li>
      </ul>
      <p>
        Your consent covers this document only. It does not mean you agree to receive other notices or documents from the sender
        electronically; if they want to do that, they must ask you separately.
      </p>

      <h2>You do not have to sign electronically</h2>
      <p>
        Signing electronically is your choice. If you would rather sign on paper, do not tick the box. Decline on the
        signing page and say that you want a paper copy, or contact the sender directly. The sender will tell
        you how they can provide the document on paper and whether choosing paper affects their timing or any fee.
      </p>

      <h2>Withdrawing your consent</h2>
      <p>
        You can withdraw your consent at any time <strong>before you sign</strong>, at no cost: close the signing page without
        signing, or decline. Nothing is signed until you press the final sign button.
      </p>
      <p>
        Once you have signed, withdrawing consent to electronic records does not undo your signature or cancel the agreement. Whether
        and how the agreement itself can be ended is set out in the agreement and by the law that applies to it. To stop receiving
        anything further electronically after signing, contact the sender.
      </p>

      <h2>Getting a paper copy</h2>
      <p>
        When everyone has signed, you will be emailed the completed document as a PDF, and you can download it from your signing link.
        You can print it yourself at any time. You may also ask the sender for a paper copy; contact them using the details in their
        email or in the agreement. The sender will tell you if they charge for paper copies.
      </p>
      <p>Keep your copy somewhere safe. You should not rely on the signing link remaining available indefinitely.</p>

      <h2>What you need</h2>
      <p>To read, sign and keep the document you need:</p>
      <ul>
        <li>a phone, tablet or computer connected to the internet;</li>
        <li>a current version of a common web browser, such as Chrome, Safari, Edge or Firefox, with JavaScript switched on;</li>
        <li>an email address you can receive messages at;</li>
        <li>a way to view PDF files, which current browsers and phones include, and enough storage or a printer to keep your copy.</li>
      </ul>
      <p>
        If the document is shown to you in full on the signing page, your device meets these requirements. If it does not display
        properly, do not sign; tell the sender.
      </p>

      <h2>Keeping your contact details up to date</h2>
      <p>
        The signing request and the completed copy are sent to the email address the sender has for you. If that address is wrong or
        changes before you receive your completed copy, tell the sender so they can correct it and send a new link. The old link
        stops working when they do.
      </p>

      <h2>What is recorded when you sign</h2>
      <p>
        So that there is a reliable record of the signature, the following is recorded and printed on a certificate attached to the
        completed document: your name and email address, the date and time you consented and signed, and the network (IP) address and
        browser you used. The sender and anyone else who signed receive the same completed document.
      </p>

      <h2>Questions</h2>
      <p>
        Questions about the document, or about anything in this disclosure, should go to the sender. Their name is at the top of the
        signing page and in the email that brought you there. {PRODUCT_NAME} provides the signing service and is not a party to
        your agreement.
      </p>
    </Article>
  );
}
