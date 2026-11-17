# Signgate: submission

- **Use it:** https://signgate-theta.vercel.app
- **Code:** https://github.com/SapnilPatel/signgate (private; `theastraway` is invited as a collaborator)
- **API reference:** https://signgate-theta.vercel.app/docs/api

## What I built

Signgate gets a company's standard client agreement signed on every file, with nobody chasing it.

The client's request has two halves, and I built for both:

1. *"Automate getting that agreement signed on every file."* A company adds its agreement once. After
   that, opening a file sends the agreement, reminds the client, collects the countersignature, seals
   the signed PDF and marks the file signed. A person only gets involved when something needs a decision.
2. *"Then sell it to every other company in our industry."* It is multi-tenant from the first table:
   any company can sign up, add its own agreement, brand the signing page, invite its team and connect
   its own systems. Nothing in it is specific to Astra AI or to MIND.

### How to test it with an agreement I have never seen

1. Create an account at `/signup` and confirm your email from the message you receive.
2. **Agreements → Add agreement.** Upload the MIND client agreement (PDF, Word, image or pasted text).
3. Review what was detected. Each field is drawn on the document and coloured by who fills it:
   the client, your company, or filled automatically. Drag anything that is off, then **Use this agreement**.
4. **Files → New file.** Enter a client name and an email address you can read. The agreement is emailed;
   the signing link is also shown on screen.
5. Open the link (a phone works best), sign, then countersign from the file page if the agreement
   has a company signature.
6. Download the sealed PDF from the file page and drop it on `/verify`.

## The decisions that shaped it

**The agreement is unknown, so nothing may depend on it.** This was the constraint I designed around.

- *Any format.* PDF, Word, images and pasted text all become one normalized PDF. The type is decided
  from the file's content, not its name.
- *Detection proposes, a person confirms.* Signgate reads the page geometry and proposes fields:
  signature lines, labels above or below lines, two-column and table signature blocks, blocks split
  across a page break, initials, and blanks in the body such as the client's name and the date. The
  sender sees the proposal on the document and corrects it before anything is sent. I did not trust
  full automation with a legal document nobody has reviewed.
- *There is always a way to sign.* If detection finds no place to sign, a signature page is appended.
  If the server cannot open a PDF at all (files "secured" against editing are common), the browser
  renders the pages to images and the agreement is rebuilt from those. An upload cannot dead-end.
- *AI is an improvement, not a dependency.* An optional AI pass can reclassify the candidates the rules
  found, but only by pointing at real lines of text, so it cannot invent coordinates. Any AI failure
  falls back silently to the rules. The live deployment runs on rules alone, so what you test does not
  depend on a model being available.

**A "file" is the unit, because that is how these companies work.** Law firms, mortgage brokers, public
adjusters, accountants and consultancies all open a file per client job, and the agreement is the gate
before work starts. So the home screen is the list of files with one question answered at a glance:
which ones are still waiting on a signature.

**Honest status over optimistic status.** If an email fails, the sender is told and given the link to
share. A link that cannot be signed says exactly why. A file's status is never "sent" when nothing was sent.

**A signature has to hold up.** Each signer gives explicit consent to sign electronically (ESIGN / UETA).
The sealed PDF carries a certificate with each signer's consent time, signing time, IP address and device,
the full event timeline, and the SHA-256 of the document they were shown. The verify page lets anyone
confirm a copy is unaltered, computing the hash in the browser so the document is never uploaded.

## Features I included, and why

| Feature | Why it is in |
|---|---|
| Upload of PDF, Word, image, text | "The same agreement" exists in different forms at different companies. Requiring one format would lose customers at step one. |
| Automatic field detection with a review editor | The agreement is unseen. Detection saves the setup work; the editor makes the result trustworthy. |
| Appended signature page and page-image fallback | Guarantees every agreement can be signed, whatever its layout or protection. |
| Prefilled fields (client name, date, file number, custom values) | "On every file" means the per-client blanks must fill themselves, or someone is back to editing documents. |
| Automatic send when a file is opened | This is the automation the client asked for. It can be switched off per file or per company. |
| Reminders, expiry, and chasing the countersigner | The manual work today is not sending the agreement; it is following up. |
| Countersignature, by hand or automatic with a saved signature | Client agreements are usually two-party. Automatic countersigning removes the last manual step for companies that want it. |
| Mobile-first signing page, no account needed | Clients sign once, from an email, usually on a phone. Any friction here is a file that sits idle. |
| Draw, type or upload a signature | People differ, and a finger on a phone is not always practical. |
| Decline with a reason, void, resend, correct the email, send again | Real files go wrong: typos in addresses, clients who refuse, agreements sent by mistake. |
| Sealed PDF with certificate, hash and public verify page | The signed agreement is a legal record. It needs to prove itself without Signgate's word for it. |
| Audit timeline on every file | Answers "did they get it, did they open it" without asking the client. |
| Multi-company accounts, roles, invitations | Required to sell it to anyone else. Roles matter because whoever can countersign binds the company. |
| Branding (colour, logo, reply-to) and emails in the company's name | A client trusts a request from the firm they hired, not from a tool they have never heard of. |
| CSV import | A company adopting this already has open files. |
| REST API, webhooks, API docs | Companies in this industry run case or loan systems. "Every file" becomes truly automatic when that system creates the file here. |
| Public intake link | For firms whose clients start the relationship themselves from a website. |
| Email verification as a soft gate | Stops a new account using the platform to email strangers, without ever blocking signing: the link can always be shared by hand. |
| Rate limits, tenant isolation, same-origin checks, hashed link secrets | A product that holds signed agreements for many companies has to be safe by default. |

## Features I deliberately left out, and why

| Left out | Why |
|---|---|
| Certificate-based digital signatures (PAdES, Adobe trust list) | Needs a paid certificate authority and adds no legal validity under ESIGN / UETA for a client agreement. The hash, certificate page and verify page give tamper evidence without it. First thing I would add for regulated buyers. |
| Billing and subscriptions | Needed to sell, not needed to get an agreement signed. Pricing is also a decision for the client, not for me. |
| More than one client signer, or custom signing order | The request is one client per file signing one standard agreement. Co-signers and routing are a different product (a general e-signature tool) and would complicate the screen every client sees. |
| Several documents per file (packets) | Same reason: "the same agreement on every file". Multiple agreement templates are supported; one is sent per file. |
| Editing the agreement's wording inside the product | Companies already have their agreement and their counsel. Signgate fills blanks and collects signatures; it does not draft. |
| OCR for scanned agreements | Scans still work (fields are placed by hand or on an appended page). OCR would add a heavy dependency for a case a company fixes once by exporting a proper PDF. |
| SMS delivery, identity checks (ID, knowledge-based), notarization | Each needs a paid third party and, for some, licensing. Email plus a secret link is the accepted standard for client agreements. |
| Native integrations with specific CRMs or case systems | I do not know which systems this industry's buyers run. The API and webhooks let any of them connect; named integrations should follow real customer demand. |
| Single sign-on and two-factor sign-in | Worth adding for larger firms. Not what stands between a small firm and a signed agreement. |
| Each company sending from its own email domain | Emails carry the company's name and reply-to, but come from the deployment's address. Per-company domains need DNS work by every customer; I would add it as an option, not a requirement. |
| Fonts for Chinese, Japanese, Korean, Arabic and Hebrew in stamped text | The embedded font covers Latin, Greek, Cyrillic and Vietnamese. Other scripts in a typed name are flagged on the certificate rather than silently dropped; drawn signatures are unaffected. Full coverage needs about 16 MB of fonts per function. |
| Hiding whether an email is already registered at sign-up | Doing it properly means sign-up cannot sign you in until you click an emailed link. I chose a smoother first minute and limited sign-up attempts instead. |

## Decisions where the brief was unclear

- **"Our industry."** Astra AI is an AI consulting firm selling to file-based businesses (law, mortgage,
  insurance, accounting). I built for any firm that opens a file per client, rather than guessing one vertical.
- **Who signs.** I assumed the client always signs, and the company signs when the agreement has a place
  for it. If the agreement has no company signature block, it completes the moment the client signs.
- **"Signed."** A file is signed when every required party has signed and the sealed PDF exists.
  Until then it shows who it is waiting on.
- **Sending email on the live site.** The deployment sends through a Gmail account, because that needs
  no domain. With a verified domain it switches to Resend by configuration alone. Gmail limits it to
  roughly 500 messages a day.
- **Scheduled work.** The host's free plan runs scheduled jobs once a day, so reminders and expiry are
  also advanced whenever anyone uses the product, guarded by a database lease.
- **Data.** Only test data was used. The live test creates companies under plus-addresses of the
  project's own mailbox.

## How it was verified

- About 880 unit and service tests against an in-memory Postgres, including concurrency cases
  (two submissions of the same link produce one signature) and cross-company access attempts.
- 15 browser journeys with Playwright, client side on a phone profile, asserting on the bytes of the
  downloaded PDF.
- A live smoke test against the deployed site with real email: sign up, verify, upload, send, sign on
  a phone, countersign, download, verify.
- Two rounds of adversarial review by independent reviewers (documents built to break detection,
  security and tenancy, concurrency and failure, hosting limits, an evaluator simulation), with every
  confirmed finding fixed and covered by a regression test.

## Tools and services

- **Languages and frameworks:** TypeScript, Next.js 16 (App Router), React 19, Tailwind CSS 4.
- **Data:** Postgres on Neon, Drizzle ORM; PGlite for local development and tests.
- **Documents:** pdf-lib, PDF.js (pdfjs-dist and unpdf), mammoth for Word, Noto Sans (SIL Open Font License).
- **Email:** Nodemailer over Gmail SMTP on the live site; Resend supported.
- **Hosting:** Vercel.
- **Testing:** Vitest, Playwright.
- **AI assistance:** Claude Code (Anthropic's Claude) was used throughout. I directed the product decisions
  and scope; Claude wrote most of the code as a team of parallel agents (builders, independent reviewers
  told to break each other's work, and fixers), and I reviewed and integrated the results. The optional
  in-product field-detection pass also uses the Anthropic API when a key is configured.
