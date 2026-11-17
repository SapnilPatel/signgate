import {
  CLIENT_ONLY_TEXT,
  activate,
  addAgreementText,
  createFile,
  expect,
  go,
  openToSign,
  signUp,
  signWithTypedSignature,
  test,
  type CreatedFile,
} from "./support";
import type { Page } from "@playwright/test";

/** A company with a client-only agreement in use and one file waiting on its client. */
async function fileWaitingOnClient(office: Page, label: string): Promise<CreatedFile & { company: string }> {
  const company = await signUp(office, label);
  await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await activate(office);
  return { ...(await createFile(office, { name: "Jordan Avery" })), company: company.name };
}

test("a client declines, the office sees why, and sending again gives a new working link", async ({ office, phone }) => {
  const file = await fileWaitingOnClient(office, "Decline Works");

  await openToSign(phone, file.signingUrl);
  await phone.getByRole("button", { name: "Decline to sign" }).click();
  const dialog = phone.getByRole("dialog", { name: "Decline to sign this agreement?" });
  await expect(dialog).toContainText(`${file.company} is told that you declined, and this link stops working.`);
  await dialog.getByRole("textbox").fill("The fee is not what we discussed.");
  await dialog.getByRole("button", { name: "Decline to sign" }).click();
  await expect(phone.getByRole("heading", { level: 1, name: "This agreement was declined" })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Finish and sign" })).toHaveCount(0);

  await go(office, file.fileUrl);
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Declined");
  await expect(office.getByText(/Jordan Avery declined to sign/)).toBeVisible();
  await expect(office.getByText("The fee is not what we discussed.").first()).toBeVisible();

  // Send it again: a new link is issued and the old one stays dead.
  await office.getByRole("button", { name: /^Send/ }).click();
  const link = office.getByLabel("Signing link for Jordan Avery");
  await expect(link).toBeVisible({ timeout: 60_000 });
  const freshUrl = await link.inputValue();
  expect(freshUrl).not.toBe(file.signingUrl);
  await expect(office.getByRole("heading", { level: 1 })).not.toContainText("Declined");

  await phone.goto(file.signingUrl);
  await expect(phone.getByRole("button", { name: "Finish and sign" })).toHaveCount(0);
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText(/declined|cancelled|does not work/);

  await signWithTypedSignature(phone, freshUrl, "Jordan Avery");
  await expect(phone.getByRole("link", { name: "Download signed copy" })).toBeVisible({ timeout: 60_000 });
});

test("voiding an agreement asks first and kills the signing link", async ({ office, phone }) => {
  const file = await fileWaitingOnClient(office, "Void Works");

  await go(office, file.fileUrl);
  await office.getByRole("button", { name: "Void agreement" }).click();
  const dialog = office.getByRole("dialog", { name: "Void this agreement?" });
  await expect(dialog).toContainText("The signing link stops working at once");

  // Backing out changes nothing.
  await dialog.getByRole("button", { name: "Keep the agreement" }).click();
  await expect(dialog).toBeHidden();
  await openToSign(phone, file.signingUrl);

  await office.getByRole("button", { name: "Void agreement" }).click();
  await dialog.getByLabel(/Reason/).fill("Sent to the wrong client.");
  await dialog.getByRole("button", { name: "Void agreement" }).click();
  await expect(dialog).toBeHidden();
  // With no agreement out any more, the file is back to "not sent".
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Not sent");
  await expect(office.getByText(/The agreement was voided .*so its signing link no longer works/)).toBeVisible();
  await expect(office.getByText("Sent to the wrong client.").first()).toBeVisible();

  // The client had the page open; it no longer offers anything to sign.
  await phone.reload();
  await expect(phone.getByRole("heading", { level: 1, name: "This signing request was cancelled" })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Finish and sign" })).toHaveCount(0);
});

test("a link that was already used says so, and an unknown link explains itself", async ({ office, phone, another }) => {
  const file = await fileWaitingOnClient(office, "Link States");

  await signWithTypedSignature(phone, file.signingUrl, "Jordan Avery");
  await expect(phone.getByRole("link", { name: "Download signed copy" })).toBeVisible({ timeout: 60_000 });

  // Opening the link again, even somewhere else, never offers signing a second time.
  const elsewhere = await another("phone");
  await elsewhere.goto(file.signingUrl);
  await expect(elsewhere.getByRole("heading", { level: 1, name: "This agreement is signed and complete" })).toBeVisible();
  await expect(elsewhere.getByRole("button", { name: "Finish and sign" })).toHaveCount(0);
  await expect(elsewhere.getByRole("checkbox")).toHaveCount(0);

  // A link with a character changed, as when it is cut off or mistyped.
  const last = file.signingUrl.slice(-1);
  await elsewhere.goto(file.signingUrl.slice(0, -1) + (last === "A" ? "B" : "A"));
  await expect(elsewhere.getByRole("heading", { level: 1, name: "This signing link does not work" })).toBeVisible();
  await expect(elsewhere.getByText("check that the whole address was copied")).toBeVisible();
  // Nothing about any company or agreement leaks on an unknown link.
  await expect(elsewhere.getByText(file.company)).toHaveCount(0);
  await expect(elsewhere.getByText("Jordan Avery")).toHaveCount(0);
});

test("a client who has signed and is waiting on the company sees that, not the form again", async ({ office, phone }) => {
  // Two-party wording: the client signs, then the client's link reports the waiting state.
  const company = await signUp(office, "Waiting State");
  await addAgreementText(office, "Two party terms", ["Terms of business", "", "Client", "Signature: ______________________", "", "Company", "Signature: ______________________"].join("\n"));
  await activate(office);
  const file = await createFile(office, { name: "Jordan Avery" });

  await signWithTypedSignature(phone, file.signingUrl, "Jordan Avery");
  await expect(phone.getByRole("heading", { level: 1, name: "Thank you. You have signed." })).toBeVisible();
  await phone.goto(file.signingUrl);
  await expect(phone.getByRole("heading", { level: 1, name: "You have signed this agreement" })).toBeVisible();
  await expect(phone.getByText(`When ${company.name} has signed their part`)).toBeVisible();
  await expect(phone.getByRole("button", { name: "Finish and sign" })).toHaveCount(0);
});
