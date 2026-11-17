import {
  CLIENT_ONLY_TEXT,
  activate,
  addAgreementText,
  createFile,
  expect,
  fetchBytes,
  fieldBoxes,
  go,
  hrefOf,
  pdfText,
  signUp,
  signWithTypedSignature,
  test,
} from "./support";

test("a pasted, client-only agreement completes as soon as the client signs", async ({ office, phone }) => {
  const company = await signUp(office, "Northside Mortgages");

  await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await expect(office.getByRole("heading", { level: 1, name: "Engagement terms" })).toBeVisible();
  await expect(fieldBoxes(office, /signature, filled by the client/)).toHaveCount(1);
  await expect(fieldBoxes(office, /filled by your company/)).toHaveCount(0);
  await activate(office);

  const file = await createFile(office, { name: "Priya Patel-Okafor" });

  await signWithTypedSignature(phone, file.signingUrl, "Priya Patel-Okafor");
  // Nobody countersigns, so the client is done and can take their copy straight away.
  const download = phone.getByRole("link", { name: "Download signed copy" });
  await expect(download).toBeVisible({ timeout: 60_000 });
  await expect(phone.getByText(/will now countersign/)).toHaveCount(0);

  // The same link keeps working afterwards and serves the sealed PDF.
  await phone.goto(file.signingUrl);
  await expect(phone.getByRole("heading", { level: 1, name: "This agreement is signed and complete" })).toBeVisible();
  const signed = await fetchBytes(phone, await hrefOf(phone.getByRole("link", { name: "Download signed copy" })));
  expect(signed.status).toBe(200);
  expect(signed.type).toContain("application/pdf");
  const text = await pdfText(signed.body);
  expect(text.pages[0]).toContain("Engagement terms");
  expect(text.all).toContain("Priya Patel-Okafor");
  expect(text.all).toContain(file.clientEmail);
  expect(text.pages[text.pages.length - 1]).toMatch(/certificate/i);
  expect(text.all).toContain(company.name);

  // The company sees the file cleared with no step of its own.
  await go(office, file.fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Signed");
  await expect(office.getByText("This file is cleared to start.")).toBeVisible();
  await expect(office.getByRole("button", { name: /^Sign for/ })).toHaveCount(0);
  await expect(office.getByRole("link", { name: "Download the signed PDF" })).toBeVisible();
});
