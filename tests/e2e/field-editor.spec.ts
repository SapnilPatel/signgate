import type { Locator, Page } from "@playwright/test";
import { addAgreementFile, expect, fieldBoxes, go, ready, signIn, signUp, test, twoPartyPdf } from "./support";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a field sits as fractions of its page, which is what is saved and must survive a reload at any zoom. */
async function placeOf(page: Page, field: Locator): Promise<Rect> {
  const sheet = await page.getByRole("img", { name: "Page 1 of 1" }).boundingBox();
  const box = await field.boundingBox();
  if (!sheet || !box) throw new Error("The page or the field is not on screen.");
  return { x: (box.x - sheet.x) / sheet.width, y: (box.y - sheet.y) / sheet.height, w: box.width / sheet.width, h: box.height / sheet.height };
}

function expectSamePlace(actual: Rect, expected: Rect) {
  for (const key of ["x", "y", "w", "h"] as const) expect(actual[key], key).toBeCloseTo(expected[key], 2);
}

/**
 * Press on a point of a field and drag it. Hovering through the locator first waits for
 * the page to stop scrolling (selecting or adding a field scrolls it into view smoothly).
 */
async function drag(page: Page, field: Locator, grab: "middle" | "bottom-right", by: { dx: number; dy: number }) {
  const size = await field.boundingBox();
  if (!size) throw new Error("The field is not on screen.");
  const position = grab === "middle" ? { x: size.width / 2, y: size.height / 2 } : { x: size.width - 1, y: size.height - 1 };
  await field.hover({ position });
  const box = await field.boundingBox();
  if (!box) throw new Error("The field is not on screen.");
  const from = { x: box.x + position.x, y: box.y + position.y };
  await page.mouse.down();
  await page.mouse.move(from.x + by.dx / 2, from.y + by.dy / 2, { steps: 5 });
  await page.mouse.move(from.x + by.dx, from.y + by.dy, { steps: 5 });
  await page.mouse.up();
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
}

test("fields can be added, moved, resized and deleted, and the changes are kept", async ({ office }) => {
  await signUp(office, "Editor Works");
  await addAgreementFile(office, { name: "client-services-agreement.pdf", mimeType: "application/pdf", buffer: await twoPartyPdf() });
  await expect(office.getByText("6 in all")).toBeVisible();
  await expect(office.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // Add: choose a kind, then click the page where it goes.
  const sheet = office.getByRole("img", { name: "Page 1 of 1" });
  const sheetSize = await sheet.boundingBox();
  if (!sheetSize) throw new Error("The page is not on screen.");
  await office.getByRole("group", { name: "Kind of field to add" }).getByRole("button", { name: "Initials" }).click();
  // The click lands on the layer that lies over the page image, hence "force".
  await sheet.click({ position: { x: sheetSize.width * 0.8, y: sheetSize.height * 0.12 }, force: true });
  const initials = fieldBoxes(office, /initials, filled by the client/);
  await expect(initials).toHaveCount(1);
  await expect(office.getByText("7 in all")).toBeVisible();
  await expect(office.getByText("All changes saved")).toHaveCount(0);

  // Move: drag the client's name sideways and down.
  const name = fieldBoxes(office, /^Client name, name, filled by the client/);
  const nameBefore = await placeOf(office, name);
  await drag(office, name, "middle", { dx: 60, dy: 24 });
  const nameMoved = await placeOf(office, name);
  expect(nameMoved.x).toBeGreaterThan(nameBefore.x + 0.03);
  expect(nameMoved.y).toBeGreaterThan(nameBefore.y + 0.01);
  expect(nameMoved.w).toBeCloseTo(nameBefore.w, 2);

  // Resize: pull the bottom-right corner of the client's signature outwards.
  const signature = fieldBoxes(office, /^Client signature, signature, filled by the client/);
  await signature.click();
  const sigBefore = await placeOf(office, signature);
  await drag(office, signature, "bottom-right", { dx: 50, dy: 14 });
  const sigResized = await placeOf(office, signature);
  expect(sigResized.w).toBeGreaterThan(sigBefore.w + 0.03);
  expect(sigResized.h).toBeGreaterThan(sigBefore.h + 0.005);
  expect(sigResized.x).toBeCloseTo(sigBefore.x, 2);
  expect(sigResized.y).toBeCloseTo(sigBefore.y, 2);

  // Delete: with the keyboard, on the company's date.
  const companyDate = fieldBoxes(office, /^Company signing date/);
  await companyDate.focus();
  await office.keyboard.press("Delete");
  await expect(companyDate).toHaveCount(0);
  await expect(office.getByText("6 in all")).toBeVisible();

  // Undo brings it back; redo removes it again.
  await office.getByRole("button", { name: "Undo" }).click();
  await expect(companyDate).toHaveCount(1);
  await office.getByRole("button", { name: "Redo" }).click();
  await expect(companyDate).toHaveCount(0);

  await save(office);
  await office.reload();
  await expect(office.getByText("6 in all")).toBeVisible();
  await ready(office);
  await expect(initials).toHaveCount(1);
  await expect(companyDate).toHaveCount(0);
  expectSamePlace(await placeOf(office, name), nameMoved);
  expectSamePlace(await placeOf(office, signature), sigResized);
  await expect(office.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

test("saving over a colleague's newer version is refused with a way forward", async ({ office, another }) => {
  const company = await signUp(office, "Conflict Works");
  const id = await addAgreementFile(office, { name: "client-services-agreement.pdf", mimeType: "application/pdf", buffer: await twoPartyPdf() });

  // The same person, in a second browser, opens the agreement as it is now.
  const second = await another();
  await signIn(second, company.email);
  await go(second, `/agreements/${id}`);
  await expect(second.getByText("6 in all")).toBeVisible();

  // The first browser removes a field and saves.
  await fieldBoxes(office, /^Company signing date/).focus();
  await office.keyboard.press("Delete");
  await save(office);

  // The second, still showing the old version, changes something else and tries to save.
  await fieldBoxes(second, /^Client signing date/).focus();
  await second.keyboard.press("Delete");
  await second.getByRole("button", { name: "Save changes" }).click();
  const notice = second.getByRole("alert").filter({ hasText: "Someone else changed this agreement" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("your changes cannot be saved on top of theirs");

  // Reloading shows the colleague's version; the refused change was not applied.
  await second.getByRole("button", { name: "Reload the agreement" }).click();
  await expect(second.getByText("5 in all")).toBeVisible();
  await expect(fieldBoxes(second, /^Company signing date/)).toHaveCount(0);
  await expect(fieldBoxes(second, /^Client signing date/)).toHaveCount(1);
  await office.reload();
  await expect(fieldBoxes(office, /^Client signing date/)).toHaveCount(1);
});
