import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  PASSWORD,
  activate,
  addAgreementFile,
  agreeToSignElectronically,
  drawSignature,
  expect,
  go,
  hrefOf,
  openToSign,
  pdfPageCount,
  pdfText,
  ready,
  test,
  twoPartyPdf,
  typeSignature,
} from "../e2e/support";

/**
 * The evaluator's path on the deployed product, with real email: sign up, verify the
 * address from the emailed link, add an agreement, open a file, follow the emailed
 * signing link on a phone, countersign, download the sealed PDF and verify it.
 *
 * Uses plus-addresses of one mailbox we control (SMTP_USER) so nothing is sent to a stranger.
 * MAILBOX_SCRIPT points at a helper that reads that mailbox and prints the first link matching a pattern.
 */
const mailbox = process.env.SMTP_USER ?? "";
const helper = process.env.MAILBOX_SCRIPT ?? "";

function emailed(to: string, pattern: string): { match: string; info: string } {
  const out = execFileSync("python3", ["-I", helper, to, pattern, "120"], { encoding: "utf8", env: process.env }).trim().split("\n");
  return { match: out[0], info: out[1] ?? "" };
}

test("a real agreement is emailed, signed on a phone, countersigned and sealed on the live site", async ({ office, phone }) => {
  test.skip(!process.env.LIVE_URL || !mailbox || !helper, "LIVE_URL, SMTP_USER and MAILBOX_SCRIPT are required");
  const id = Date.now().toString(36);
  const [local, domain] = mailbox.split("@");
  const ownerEmail = `${local}+owner${id}@${domain}`;
  const clientEmail = `${local}+client${id}@${domain}`;
  const companyName = `Live Check ${id}`;

  await go(office, "/signup");
  await office.getByLabel("Company name").fill(companyName);
  await office.getByLabel("Your name").fill("Olivia Owner");
  await office.getByLabel("Work email").fill(ownerEmail);
  await office.getByLabel("Password").fill(PASSWORD);
  await office.getByRole("button", { name: "Create account" }).click();
  await expect(office.getByRole("heading", { level: 1, name: /Welcome to Signgate/ })).toBeVisible({ timeout: 60_000 });

  // The verification email really arrives, and its link works.
  const verify = emailed(ownerEmail, "https?://[^\\s\"<>]+/verify-email/[\\w-]+");
  console.log("verification email:", verify.info);
  // This page has no form controls, so navigate directly rather than through the helper that waits for them.
  await office.goto(new URL(verify.match).pathname);
  await expect(office.getByRole("heading", { level: 1 })).toContainText(/confirmed/i);

  await addAgreementFile(office, { name: "client-services-agreement.pdf", mimeType: "application/pdf", buffer: await twoPartyPdf() });
  await expect(office.getByText("Ready to use")).toBeVisible();
  await activate(office);

  await go(office, "/files/new");
  await office.getByLabel("Client name").fill("Casey Client");
  await office.getByLabel("Client email").fill(clientEmail);
  await office.getByRole("button", { name: "Create file and send agreement" }).click();
  await expect(office.getByRole("heading", { name: /^File .+ was created$/ })).toBeVisible({ timeout: 60_000 });
  console.log("after creating the file:", (await office.locator("main").innerText()).split("\n").slice(0, 6).join(" / "));
  const shownLink = await office.getByLabel("Signing link for Casey Client").inputValue();
  const fileUrl = await hrefOf(office.getByRole("link", { name: "Open the file" }));

  // The client receives the request by email, and the emailed link is the signing link.
  const request = emailed(clientEmail, "https?://[^\\s\"<>]+/sign/[\\w-]{20,}");
  console.log("signing request email:", request.info);
  expect(request.match).toBe(shownLink);
  expect(request.info).toContain(companyName);

  await openToSign(phone, request.match);
  await agreeToSignElectronically(phone);
  await phone.getByRole("button", { name: /^Client signature \(required\)/ }).click();
  await drawSignature(phone);
  await phone.getByRole("button", { name: "Finish and sign" }).click();
  await expect(phone.getByRole("heading", { level: 1, name: "Thank you. You have signed." })).toBeVisible();

  await go(office, fileUrl);
  await office.getByRole("button", { name: `Sign for ${companyName}` }).click();
  await office.waitForURL(/\/sign\//);
  await ready(office);
  await agreeToSignElectronically(office);
  await office.getByRole("button", { name: /^Company signature \(required\)/ }).click();
  await typeSignature(office, "Olivia Owner");
  await office.getByRole("button", { name: "Finish and sign" }).click();
  await expect(office.getByRole("heading", { level: 1 })).toContainText(/signed/i);

  await go(office, fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Signed");
  const [download] = await Promise.all([
    office.waitForEvent("download"),
    office.getByRole("link", { name: "Download the signed PDF" }).click(),
  ]);
  const sealed = await readFile(await download.path());
  expect(await pdfPageCount(sealed)).toBeGreaterThanOrEqual(2);
  const text = await pdfText(sealed);
  expect(text.all).toContain("Casey Client");
  expect(text.all).toContain(clientEmail);
  expect(text.all).toMatch(/certificate/i);

  // The client is emailed the completed copy.
  const completed = emailed(clientEmail, "(?i)signed|complete");
  console.log("completion email:", completed.info);

  await go(phone, "/verify");
  await phone.locator('input[type="file"]').setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: sealed });
  await expect(phone.getByRole("heading", { name: "This is a sealed, unaltered agreement" })).toBeVisible();
});
