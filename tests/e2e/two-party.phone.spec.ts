import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  activate,
  addAgreementFile,
  agreeToSignElectronically,
  createFile,
  drawSignature,
  expect,
  fieldBoxes,
  go,
  openToSign,
  pdfPageCount,
  pdfText,
  ready,
  signUp,
  test,
  twoPartyPdf,
  typeSignature,
} from "./support";

test("a two-party agreement goes from upload to a sealed, verifiable PDF", async ({ office, phone }) => {
  const company = await signUp(office, "Harbour Legal");

  // Add the agreement and check what detection found.
  await addAgreementFile(office, { name: "client-services-agreement.pdf", mimeType: "application/pdf", buffer: await twoPartyPdf() });
  await expect(office.getByRole("heading", { level: 1, name: /client.services.agreement/i })).toBeVisible();
  await expect(office.getByText(/Found 2 signature blocks/)).toBeVisible();
  await expect(fieldBoxes(office, /filled by the client/)).toHaveCount(3);
  await expect(fieldBoxes(office, /filled by your company/)).toHaveCount(3);
  await expect(fieldBoxes(office, /^Client signature, signature, filled by the client/)).toBeVisible();
  await expect(fieldBoxes(office, /^Company signature, signature, filled by your company/)).toBeVisible();
  await expect(office.getByText("Ready to use")).toBeVisible();

  await activate(office);
  await expect(office.getByText("It is your default agreement")).toBeVisible();

  // Create a file; with no email set up, the signing link is shown instead.
  const file = await createFile(office, { name: "Casey Client" });
  await expect(office.getByText("The agreement is ready to sign, but it was not emailed")).toBeVisible();

  // The client signs on a phone, drawing the signature.
  await openToSign(phone, file.signingUrl);
  await expect(phone.getByRole("heading", { level: 1, name: /client.services.agreement/i })).toBeVisible();
  await expect(phone.getByText(`${company.name} sent this agreement for you to read and sign, Casey Client.`)).toBeVisible();
  await expect(phone.getByRole("button", { name: /^Company signature/ })).toHaveCount(0);
  await agreeToSignElectronically(phone);
  await phone.getByRole("button", { name: /^Client signature \(required\)/ }).click();
  await drawSignature(phone);
  await expect(phone.getByRole("button", { name: /^Client signature: your signature is added/ })).toBeVisible();
  await phone.getByRole("button", { name: "Finish and sign" }).click();
  await expect(phone.getByRole("heading", { level: 1, name: "Thank you. You have signed." })).toBeVisible();
  await expect(phone.getByText(`${company.name} will now countersign.`)).toBeVisible();

  // The company sees it waiting and countersigns.
  await go(office, file.fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Waiting on us");
  await expect(office.getByText("Casey Client signed today.")).toBeVisible();
  await office.getByRole("button", { name: `Sign for ${company.name}` }).click();
  await office.waitForURL(/\/sign\//);
  await expect(office.getByRole("button", { name: "Finish and sign" })).toBeVisible();
  await ready(office);
  await agreeToSignElectronically(office);
  await office.getByRole("button", { name: /^Company signature \(required\)/ }).click();
  await typeSignature(office, company.ownerName);
  await office.getByRole("button", { name: "Finish and sign" }).click();
  await expect(office.getByRole("heading", { level: 1 })).toContainText(/signed/i);

  // The file is cleared and the sealed PDF can be downloaded.
  await go(office, file.fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Signed");
  const downloadLink = office.getByRole("link", { name: "Download the signed PDF" });
  await expect(downloadLink).toBeVisible();
  const [download] = await Promise.all([office.waitForEvent("download"), downloadLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const sealed = await readFile(await download.path());
  expect(sealed.subarray(0, 5).toString()).toBe("%PDF-");

  // The original had one page; the sealed copy adds the certificate.
  expect(await pdfPageCount(sealed)).toBeGreaterThanOrEqual(2);
  const text = await pdfText(sealed);
  expect(text.pages[0]).toContain("Client Services Agreement");
  expect(text.pages[0]).toContain("Casey Client");
  expect(text.pages[0]).toContain(company.ownerName);
  const certificate = text.pages.slice(1).join(" ");
  expect(certificate).toMatch(/certificate/i);
  expect(certificate).toContain("Casey Client");
  expect(certificate).toContain(file.clientEmail);
  expect(certificate).toContain(company.ownerName);
  expect(certificate).toContain(company.name);

  // The client's link now offers the same sealed copy.
  await phone.reload();
  await expect(phone.getByRole("heading", { level: 1, name: "This agreement is signed and complete" })).toBeVisible();
  await expect(phone.getByRole("link", { name: "Download signed copy" })).toBeVisible();

  // Anyone can check the PDF is genuine, without an account; a changed copy does not match.
  await go(phone, "/verify");
  await phone.locator('input[type="file"]').setInputFiles({ name: "signed-agreement.pdf", mimeType: "application/pdf", buffer: sealed });
  await expect(phone.getByRole("heading", { name: "This is a sealed, unaltered agreement" })).toBeVisible();
  await expect(phone.getByText(/^client.services.agreement$/i)).toBeVisible();
  await expect(phone.getByText(company.name, { exact: true })).toBeVisible();
  await expect(phone.getByText("Casey Client", { exact: true })).toBeVisible();
  await expect(phone.getByText(createHash("sha256").update(sealed).digest("hex"))).toBeVisible();
  // The verify page shows addresses only in part.
  await expect(phone.getByText(file.clientEmail)).toHaveCount(0);

  const tampered = Buffer.concat([sealed, Buffer.from("\n% changed after sealing\n")]);
  await phone.locator('input[type="file"]').setInputFiles({ name: "changed.pdf", mimeType: "application/pdf", buffer: tampered });
  await expect(phone.getByRole("heading", { name: "No match found" })).toBeVisible();
});
