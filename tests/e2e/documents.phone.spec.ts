import {
  NO_SIGNATURE_TEXT,
  WORD_MIME,
  activate,
  addAgreementFile,
  addAgreementText,
  createFile,
  expect,
  fetchBytes,
  fieldBoxes,
  hrefOf,
  pdfPageCount,
  pdfText,
  signUp,
  signWithTypedSignature,
  test,
  wordDocument,
} from "./support";

test("a Word document becomes an agreement with its signature blocks found", async ({ office, phone }) => {
  await signUp(office, "Wexford Conveyancing");

  const buffer = await wordDocument([
    "Conveyancing engagement",
    "We act for you in the purchase described in our letter.",
    "Our fee is fixed and is due on completion.",
    "",
    "Client",
    "Signature: ______________________________",
    "Print name: ______________________________",
    "Date: ________________",
    "",
    "Company",
    "Signature: ______________________________",
    "Print name: ______________________________",
    "Date: ________________",
  ]);
  const id = await addAgreementFile(office, { name: "Conveyancing engagement.docx", mimeType: WORD_MIME, buffer });
  await expect(office.getByRole("heading", { level: 1, name: "Conveyancing engagement" })).toBeVisible();
  await expect(fieldBoxes(office, /signature, filled by the client/)).toHaveCount(1);
  await expect(fieldBoxes(office, /signature, filled by your company/)).toHaveCount(1);

  // The Word file was converted to a PDF that keeps its wording.
  const converted = await fetchBytes(office, `/api/app/templates/${id}/pdf`);
  expect(converted.status).toBe(200);
  expect((await pdfText(converted.body)).all).toContain("We act for you in the purchase described in our letter.");

  await activate(office);
  const file = await createFile(office, { name: "Morgan Reyes" });
  await signWithTypedSignature(phone, file.signingUrl, "Morgan Reyes");
  await expect(phone.getByRole("heading", { level: 1, name: "Thank you. You have signed." })).toBeVisible();
});

test("an agreement with nowhere to sign gets a signature page, and can be signed", async ({ office, phone }) => {
  await signUp(office, "Lakeview Advisers");

  const id = await addAgreementText(office, "Privacy notice", NO_SIGNATURE_TEXT);
  await expect(office.getByText(/signature page/i).first()).toBeVisible();
  await expect(fieldBoxes(office, /signature, filled by the client/)).toHaveCount(1);

  // The page was added to the document itself, after the wording.
  const prepared = await fetchBytes(office, `/api/app/templates/${id}/pdf`);
  const pages = await pdfPageCount(prepared.body);
  expect(pages).toBeGreaterThanOrEqual(2);
  expect((await pdfText(prepared.body)).pages[0]).toContain("Privacy notice");

  await activate(office);
  const file = await createFile(office, { name: "Sam Whitlock" });

  await signWithTypedSignature(phone, file.signingUrl, "Sam Whitlock");
  const download = phone.getByRole("link", { name: "Download signed copy" }).or(phone.getByRole("heading", { level: 1, name: "Thank you. You have signed." }));
  await expect(download.first()).toBeVisible({ timeout: 60_000 });

  // Whether or not the company countersigns, the client's signature is on the record the office sees.
  await office.goto(file.fileUrl);
  await expect(office.getByRole("region", { name: "Who signs" }).getByRole("listitem").filter({ hasText: "Sam Whitlock" })).toContainText("Signed today");
  const soFar = office.getByRole("link", { name: /Download the signed PDF|View it with the signatures so far/ });
  const copy = await fetchBytes(office, await hrefOf(soFar));
  expect(copy.status).toBe(200);
  expect(await pdfPageCount(copy.body)).toBeGreaterThanOrEqual(pages);
  expect((await pdfText(copy.body)).all).toContain("Sam Whitlock");
});
