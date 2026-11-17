import { CLIENT_ONLY_TEXT, activate, addAgreementText, expect, go, signUp, test } from "./support";

test("a CSV import brings in the good rows and says what is wrong with the bad one", async ({ office }) => {
  await signUp(office, "Import Works");
  await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await activate(office);

  const csv = ["Name,Email,Company", "Dana Whitcombe,dana@example.test,Whitcombe Farms", "Elliot Ng,not-an-email,Ng Holdings", "Farah Idowu,farah@example.test,"].join("\n");
  await go(office, "/files/import");
  await office.locator('input[type="file"]').setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });

  // Preview: the bad row is called out before anything is created.
  await expect(office.getByText("1 row has a problem and will be left out")).toBeVisible();
  const badRow = office.getByRole("row").filter({ hasText: "Elliot Ng" });
  await expect(badRow).toContainText(/email/i);
  await office.getByRole("button", { name: /^Import 2 files/ }).click();

  await expect(office.getByRole("heading", { name: "The import is finished" })).toBeVisible({ timeout: 120_000 });
  await expect(office.getByText(/2 files created.*1 row left out because of problems/)).toBeVisible();

  await go(office, "/files");
  await expect(office.getByRole("link", { name: /Dana Whitcombe/ }).first()).toBeVisible();
  await expect(office.getByRole("link", { name: /Farah Idowu/ }).first()).toBeVisible();
  await expect(office.getByText("Elliot Ng")).toHaveCount(0);
});

test("a key made in settings creates a file through the API, and the file shows in the list", async ({ office, request }) => {
  await signUp(office, "API Works");
  await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await activate(office);

  await go(office, "/settings/developers");
  await office.getByLabel("Name for a new key").fill("Case management");
  await office.getByRole("button", { name: "Create API key" }).click();
  await expect(office.getByText("Copy this key now. It will not be shown again.")).toBeVisible();
  const key = await office.getByLabel("Key for Case management").inputValue();
  expect(key.length).toBeGreaterThan(20);

  // `request` has no cookies: the key alone identifies the company.
  const headers = { Authorization: `Bearer ${key}` };
  const created = await request.post("/api/v1/files", {
    headers,
    data: { client_name: "Gale Sorensen", client_email: "gale@example.test", external_id: "case-1001", reference: "CASE-1001" },
  });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.created).toBe(true);
  expect(body.file.client_name).toBe("Gale Sorensen");
  expect(body.file.external_id).toBe("case-1001");

  // Sending the same case again returns the same file instead of a duplicate.
  const again = await request.post("/api/v1/files", { headers, data: { client_name: "Gale Sorensen", client_email: "gale@example.test", external_id: "case-1001" } });
  expect(again.status()).toBe(200);
  expect((await again.json()).file.id).toBe(body.file.id);

  // Bad input and bad keys are refused with a JSON error that says why.
  const invalid = await request.post("/api/v1/files", { headers, data: { client_name: "No Email" } });
  expect(invalid.status()).toBe(422);
  expect(JSON.stringify(await invalid.json())).toMatch(/client_email/);
  const refused = await request.get("/api/v1/files", { headers: { Authorization: `Bearer ${key.slice(0, -4)}AAAA` } });
  expect(refused.status()).toBe(401);

  await go(office, "/files");
  const row = office.getByRole("row").filter({ hasText: "Gale Sorensen" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("CASE-1001");
  await row.getByRole("link").first().click();
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Gale Sorensen");
  await expect(office.getByRole("region", { name: "Timeline" })).toContainText("Engagement terms");

  // Once the key is revoked it stops working.
  await go(office, "/settings/developers");
  await office.getByRole("button", { name: /^Revoke/ }).click();
  await office.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(office.getByText("No active keys.")).toBeVisible();
  expect((await request.get("/api/v1/files", { headers })).status()).toBe(401);
});
