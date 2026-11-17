import { CLIENT_ONLY_TEXT, PASSWORD, activate, addAgreementText, createFile, expect, fetchBytes, go, hrefOf, signUp, test } from "./support";

test("an invited member can work on files but cannot reach settings or change agreements", async ({ office, another }) => {
  const company = await signUp(office, "Team Works");
  const agreementId = await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await activate(office);

  // Invite: with no email set up the link is shown for the owner to pass on.
  const memberEmail = `member-${Date.now().toString(36)}@example.test`;
  await go(office, "/settings/team");
  await office.getByLabel("Email address").fill(memberEmail);
  await office.getByLabel("Role", { exact: true }).selectOption("member");
  await office.getByRole("button", { name: "Send invitation" }).click();
  await expect(office.getByText(`The invitation to ${memberEmail} was not emailed`)).toBeVisible();
  const inviteUrl = await office.getByLabel("Invitation link").inputValue();
  expect(inviteUrl).toMatch(/\/invite\/[\w-]{20,}$/);

  // Accept it in a separate browser.
  const member = await another();
  await go(member, inviteUrl);
  await expect(member.getByText(company.name).first()).toBeVisible();
  await expect(member.getByLabel("Email")).toHaveValue(memberEmail);
  await member.getByLabel("Your name").fill("Marlow Member");
  await member.getByLabel("Password").fill(PASSWORD);
  await member.getByRole("button", { name: "Join the team" }).click();
  await expect(member.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 60_000 });

  // The owner now sees them on the team.
  await office.reload();
  await expect(office.getByText("Marlow Member").first()).toBeVisible();

  // A member can create a file.
  const file = await createFile(member, { name: "Robin Castellanos" });
  expect(file.reference).not.toBe("");

  // Settings: every section explains instead of showing the controls.
  for (const section of ["company", "team", "developers", "signing", "branding", "email"]) {
    await member.goto(`/settings/${section}`);
    await expect(member.getByRole("heading", { name: "Only owners and admins can change company settings" })).toBeVisible();
    await expect(member.getByRole("main").getByRole("textbox")).toHaveCount(0);
    await expect(member.getByRole("main").getByRole("button")).toHaveCount(0);
  }

  // Agreements: readable, not changeable.
  await go(member, `/agreements/${agreementId}`);
  await expect(member.getByText("You can read this agreement but not change it")).toBeVisible();
  for (const name of ["Save changes", "Use this agreement", "Archive", "Duplicate", "Detect fields again", "Replace the document", "Save name"]) {
    await expect(member.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(member.getByRole("group", { name: "Kind of field to add" })).toHaveCount(0);
  await member.goto("/agreements/new");
  await expect(member.getByLabel("Agreement file")).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Choose a file" })).toHaveCount(0);

  // The endpoints behind those screens refuse a member too, not only the screens.
  // (Sent with the page's own origin, as the browser would, so it is the role that is refused.)
  const origin = new URL(member.url()).origin;
  const upload = await member.request.post("/api/app/templates", { headers: { origin }, data: { text: CLIENT_ONLY_TEXT, name: "Sneaked in" } });
  expect(upload.status()).toBe(403);
  expect((await upload.json()).error.message).toMatch(/owner|admin/i);
  // And a request from another site is refused whoever is signed in.
  const foreign = await office.request.post("/api/app/templates", { headers: { origin: "https://elsewhere.example" }, data: { text: CLIENT_ONLY_TEXT, name: "From another site" } });
  expect(foreign.status()).toBe(403);
  await office.goto("/agreements");
  await expect(office.getByText("From another site")).toHaveCount(0);
  await expect(office.getByText("Sneaked in")).toHaveCount(0);
});

test("one company cannot open another company's file, agreement or documents", async ({ office, another }) => {
  // Company A has an agreement and a file out for signature.
  await signUp(office, "Tenant A");
  const agreementId = await addAgreementText(office, "Engagement terms", CLIENT_ONLY_TEXT);
  await activate(office);
  const file = await createFile(office, { name: "Alex Achterberg" });
  await go(office, file.fileUrl);
  const documentUrl = await hrefOf(office.getByRole("link", { name: "View the agreement as sent" }));
  expect((await fetchBytes(office, documentUrl)).status).toBe(200);

  // Company B signs up and tries A's addresses.
  const other = await another();
  await signUp(other, "Tenant B");

  for (const path of [file.fileUrl, `${file.fileUrl}/edit`, `/agreements/${agreementId}`]) {
    // These pages stream behind a loading state, so the status line has already gone out
    // as 200 by the time the lookup fails; what the person gets is the not-found page.
    await other.goto(path);
    await expect(other.getByRole("heading", { name: /We could not find that page|File not found|Agreement not found/ }), path).toBeVisible();
    await expect(other.getByText("Alex Achterberg")).toHaveCount(0);
    await expect(other.getByText("Engagement terms")).toHaveCount(0);
  }

  for (const path of [
    documentUrl,
    documentUrl.replace(/kind=\w+/, "kind=in_progress"),
    `/api/app/templates/${agreementId}/pdf`,
    `/api/app/templates/${agreementId}/preview`,
  ]) {
    const response = await fetchBytes(other, path);
    expect(response.status, path).toBe(404);
    expect(response.type, path).not.toContain("application/pdf");
  }

  // Nor can B replace the wording of A's agreement.
  const replaced = await other.request.post(`/api/app/templates/${agreementId}/document`, {
    headers: { origin: new URL(other.url()).origin },
    data: { text: "Replaced by another company." },
  });
  expect(replaced.status()).toBe(404);
  await office.reload();
  await expect(office.getByRole("heading", { level: 1 })).toContainText("Alex Achterberg");

  // B's own lists do not mention A's client or agreement.
  await other.goto("/files");
  await expect(other.getByText("Alex Achterberg")).toHaveCount(0);
  await other.goto("/agreements");
  await expect(other.getByText("Engagement terms")).toHaveCount(0);

  // Signed out, the same addresses lead to sign-in, never to the document.
  const visitor = await another();
  await visitor.goto(file.fileUrl);
  await expect(visitor).toHaveURL(/\/login/);
  const anonymous = await fetchBytes(visitor, documentUrl);
  expect(anonymous.type).not.toContain("application/pdf");
  expect(anonymous.status).toBe(401);
});
