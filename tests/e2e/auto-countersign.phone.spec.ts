import { activate, addAgreementFile, createFile, expect, fetchBytes, go, hrefOf, pdfText, signUp, signWithTypedSignature, test, twoPartyPdf } from "./support";

test("with a saved signature and automatic countersigning, the client's signature completes the agreement", async ({ office, phone }) => {
  const company = await signUp(office, "Auto Works");
  await addAgreementFile(office, { name: "client-services-agreement.pdf", mimeType: "application/pdf", buffer: await twoPartyPdf() });
  await activate(office);

  // Automatic mode is refused until the countersigner has a saved signature.
  await go(office, "/settings/signing");
  await office.getByRole("radio", { name: /Apply their saved signature automatically/ }).check();
  await expect(office.getByText("you have not saved one yet")).toBeVisible();
  await office.getByRole("link", { name: "Save your signature" }).click();

  await expect(office.getByRole("tab", { name: "Type" })).toBeVisible();
  await office.getByRole("tab", { name: "Type" }).click();
  await office.getByLabel("Your name", { exact: true }).last().fill(company.ownerName);
  await office.getByRole("button", { name: "Save signature" }).click();
  await expect(office.getByRole("img", { name: `Saved signature of ${company.ownerName}` })).toBeVisible();

  await go(office, "/settings/signing");
  await office.getByRole("radio", { name: /Apply their saved signature automatically/ }).check();
  await expect(office.getByText("you have not saved one yet")).toHaveCount(0);
  await office.getByRole("button", { name: "Save countersigning" }).click();
  await expect(office.getByText("Saved. The countersigner's saved signature is applied as soon as a client signs.")).toBeVisible();
  await office.reload();
  await expect(office.getByRole("radio", { name: /Apply their saved signature automatically/ })).toBeChecked();

  const file = await createFile(office, { name: "Harper Lindqvist" });

  // The client signs and is told it is complete: no "will now countersign".
  await signWithTypedSignature(phone, file.signingUrl, "Harper Lindqvist");
  const download = phone.getByRole("link", { name: "Download signed copy" });
  await expect(download).toBeVisible({ timeout: 60_000 });
  const signed = await fetchBytes(phone, await hrefOf(download));
  const text = await pdfText(signed.body);
  expect(text.pages[0]).toContain("Harper Lindqvist");
  expect(text.pages[0]).toContain(company.ownerName);
  const certificate = text.pages.slice(1).join(" ");
  expect(certificate).toContain("Harper Lindqvist");
  expect(certificate).toContain(company.ownerName);

  // The office never had a second step.
  await go(office, file.fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Signed");
  await expect(office.getByRole("button", { name: /^Sign for/ })).toHaveCount(0);
  const who = office.getByRole("region", { name: "Who signs" }).getByRole("listitem");
  await expect(who.filter({ hasText: "Harper Lindqvist" })).toContainText("Signed today");
  await expect(who.filter({ hasText: company.ownerName })).toContainText("Signed today");
  await expect(office.getByRole("region", { name: "Timeline" })).toContainText(/automatic/i);
});
