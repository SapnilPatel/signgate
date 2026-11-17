import { test as base, devices, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

export { expect };

export const PASSWORD = "correct-horse-battery-9";

// ---------------------------------------------------------------------------
// Browser contexts
// ---------------------------------------------------------------------------

let contextCounter = 0;

/**
 * Sign-up, sign-in and signing are rate limited per network address. Every test
 * making a company from one machine would trip the sign-up limit within a dozen
 * tests, so each browser context presents its own address from the documentation
 * ranges, the way separate offices and clients would in production.
 */
function nextAddress(): string {
  contextCounter += 1;
  const salt = (process.pid + contextCounter * 7919 + Date.now()) % 60_000;
  return `198.51.${100 + (salt % 100)}.${1 + ((salt >> 3) % 250)}`;
}

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

type Kind = "office" | "phone";

async function openContext(browser: Browser, kind: Kind, baseURL: string | undefined): Promise<BrowserContext> {
  // The device descriptor also names WebKit; the browser is already launched, so only its page settings are used.
  const settings: Record<string, unknown> = kind === "phone" ? { ...devices["iPhone 13"] } : { viewport: { width: 1280, height: 900 } };
  delete settings.defaultBrowserType;
  return browser.newContext({ ...settings, baseURL, acceptDownloads: true, extraHTTPHeaders: { "x-real-ip": nextAddress() } });
}

interface Fixtures {
  /** A signed-out desktop browser, as someone at the company would use. */
  office: Page;
  /** A signed-out phone browser, as a client opening a signing link would use. */
  phone: Page;
  /** Another isolated browser: a second company, a team member, a second tab's session. */
  another: (kind?: Kind) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  another: async ({ browser, baseURL }, provide) => {
    const opened: BrowserContext[] = [];
    await provide(async (kind = "office") => {
      const context = await openContext(browser, kind, baseURL);
      opened.push(context);
      return context.newPage();
    });
    for (const context of opened) await context.close();
  },
  office: async ({ another }, provide) => {
    await provide(await another("office"));
  },
  phone: async ({ another }, provide) => {
    await provide(await another("phone"));
  },
});

// ---------------------------------------------------------------------------
// Waiting for the page to be usable
// ---------------------------------------------------------------------------

/**
 * A server-rendered control is visible before React has attached its handlers, and
 * a click or a chosen file in that gap is lost. Wait until every control on the
 * page is live. (This is a wait, not an assertion about the product.)
 */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    // Hidden inputs include the framework's own server-action fields, which React never adopts.
    const controls = Array.from(document.querySelectorAll('button, input:not([type="hidden"]), select, textarea'));
    return controls.length > 0 && controls.every((el) => Object.keys(el).some((key) => key.startsWith("__reactProps")));
  });
}

export async function go(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await ready(page);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** A one-page agreement with a labelled signature block for the client and one for the company. */
export async function twoPartyPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 720;
  const line = (text: string, size = 11) => {
    page.drawText(text, { x: 72, y, size, font });
    y -= size + 9;
  };
  line("Client Services Agreement", 18);
  y -= 10;
  line("This agreement is made between the Company and the Client named below.");
  line("1. The Company will provide the services described in the engagement letter.");
  line("2. The Client agrees to pay the fees set out in the fee schedule.");
  line("3. Either party may end this agreement with thirty days written notice.");
  for (const party of ["Client", "Company"]) {
    y -= 30;
    line(party);
    y -= 14;
    line("Signature: ______________________________");
    y -= 6;
    line("Print name: ______________________________");
    y -= 6;
    line("Date: ________________");
  }
  return Buffer.from(await doc.save());
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A minimal Word document: one paragraph per line of text. */
export async function wordDocument(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const paragraphs = lines.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

export const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Agreement wording signed by the client only. */
export const CLIENT_ONLY_TEXT = [
  "Engagement terms",
  "",
  "The client engages the firm to act in the matter described in the engagement letter.",
  "Fees are billed monthly and are payable within fourteen days.",
  "",
  "Client signature: ______________________",
  "Date: ______________",
].join("\n");

/** Agreement wording with nowhere to sign, so a signature page has to be added. */
export const NO_SIGNATURE_TEXT = [
  "Privacy notice",
  "",
  "We keep the information you give us for as long as the law requires and no longer.",
  "We share it only with the people who need it to do the work you asked for.",
  "You can ask for a copy of what we hold at any time.",
].join("\n");

/** Everything a person could read in a PDF, page by page. */
export async function pdfText(bytes: Buffer): Promise<{ pages: string[]; all: string }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(document, { mergePages: false });
  const pages = (text as string[]).map((page) => page.replace(/\s+/g, " "));
  return { pages, all: pages.join(" ") };
}

export async function pdfPageCount(bytes: Buffer): Promise<number> {
  return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
}

/** Fetch a link with the page's own cookies, the way following it in that browser would. */
export async function fetchBytes(page: Page, url: string): Promise<{ status: number; type: string; body: Buffer }> {
  const response = await page.request.get(url);
  return { status: response.status(), type: response.headers()["content-type"] ?? "", body: await response.body() };
}

export async function hrefOf(link: Locator): Promise<string> {
  const href = await link.getAttribute("href");
  if (!href) throw new Error("The link has no address.");
  return href;
}

// ---------------------------------------------------------------------------
// Company side
// ---------------------------------------------------------------------------

export interface Company {
  name: string;
  ownerName: string;
  email: string;
}

export async function signUp(page: Page, label: string): Promise<Company> {
  const id = unique();
  const company: Company = { name: `${label} ${id}`, ownerName: "Olivia Owner", email: `owner-${id}@example.test` };
  await go(page, "/signup");
  await page.getByLabel("Company name").fill(company.name);
  await page.getByLabel("Your name").fill(company.ownerName);
  await page.getByLabel("Work email").fill(company.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Welcome to Signgate/ })).toBeVisible({ timeout: 60_000 });
  return company;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await go(page, "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 60_000 });
}

/** The review screen for a newly added agreement; resolves to the agreement's id. */
async function onReview(page: Page): Promise<string> {
  await page.waitForURL(/\/agreements\/tpl_[a-z0-9]+/, { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "What we found in your document" })).toBeVisible({ timeout: 60_000 });
  await ready(page);
  return new URL(page.url()).pathname.split("/").pop() as string;
}

export async function addAgreementFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  await go(page, "/agreements/new");
  await page.getByLabel("Agreement file").setInputFiles(file);
  return onReview(page);
}

export async function addAgreementText(page: Page, name: string, text: string): Promise<string> {
  await go(page, "/agreements/new");
  await page.getByRole("button", { name: "Paste the text" }).click();
  await page.getByLabel("Name of this agreement").fill(name);
  await page.getByLabel("Agreement text").fill(text);
  await page.getByRole("button", { name: "Create agreement" }).click();
  return onReview(page);
}

export async function activate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Use this agreement" }).click();
  await expect(page.getByText("This agreement is now in use")).toBeVisible();
}

/** The fields drawn on the document in the editor or the signing page. */
export function fieldBoxes(page: Page, name: RegExp): Locator {
  return page.getByRole("group").getByRole("button", { name });
}

export interface CreatedFile {
  clientName: string;
  clientEmail: string;
  signingUrl: string;
  fileUrl: string;
  reference: string;
}

/** Create a file from /files/new. With the default settings this prepares the agreement and shows the signing link. */
export async function createFile(page: Page, client: { name?: string; email?: string } = {}): Promise<CreatedFile> {
  const clientName = client.name ?? "Casey Client";
  const clientEmail = client.email ?? `casey-${unique()}@example.test`;
  await go(page, "/files/new");
  await page.getByLabel("Client name").fill(clientName);
  await page.getByLabel("Client email").fill(clientEmail);
  await page.getByRole("button", { name: "Create file and send agreement" }).click();
  const heading = page.getByRole("heading", { name: /^File .+ was created$/ });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  const reference = ((await heading.textContent()) ?? "").replace(/^File /, "").replace(/ was created$/, "");
  const signingUrl = await page.getByLabel(`Signing link for ${clientName}`).inputValue();
  expect(signingUrl).toMatch(/\/sign\/[\w-]{20,}$/);
  const fileUrl = await hrefOf(page.getByRole("link", { name: "Open the file" }));
  return { clientName, clientEmail, signingUrl, fileUrl, reference };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Open a signing link and wait for the document to be ready to fill in. */
export async function openToSign(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Finish and sign" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("img", { name: /^Page 1 of/ })).toBeVisible({ timeout: 60_000 });
  await ready(page);
}

export async function agreeToSignElectronically(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: /I agree to use an electronic signature/ }).check();
}

/** The open signature dialog; its title differs for a client ("Add your signature") and a countersigner ("Sign for ..."). */
function signatureDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("tablist") });
}

/** Adopt a typed signature in the open signature dialog. */
export async function typeSignature(page: Page, name: string): Promise<void> {
  const dialog = signatureDialog(page);
  await dialog.getByRole("tab", { name: "Type" }).click();
  await dialog.getByLabel("Your name").fill(name);
  await dialog.getByRole("button", { name: /^Use (this signature|these initials)$/ }).click();
  await expect(dialog).toBeHidden();
}

/** Draw a signature with the pointer in the open signature dialog. */
export async function drawSignature(page: Page): Promise<void> {
  const dialog = signatureDialog(page);
  const pad = dialog.getByRole("img", { name: /^Drawing area/ });
  const box = await pad.boundingBox();
  if (!box) throw new Error("The drawing area is not on screen.");
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.move(...at(0.15, 0.6));
  await page.mouse.down();
  for (const [fx, fy] of [
    [0.25, 0.3],
    [0.35, 0.7],
    [0.45, 0.35],
    [0.55, 0.65],
    [0.7, 0.4],
    [0.85, 0.55],
  ] as const) {
    await page.mouse.move(...at(fx, fy), { steps: 6 });
  }
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Use this signature" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * The whole ceremony for a document whose only thing to do by hand is the signature:
 * agree, sign the signature field with a typed signature, finish.
 */
export async function signWithTypedSignature(page: Page, url: string, name: string): Promise<void> {
  await openToSign(page, url);
  await agreeToSignElectronically(page);
  await page.getByRole("button", { name: /signature \(required\)/i }).first().click();
  await typeSignature(page, name);
  await expect(page.getByText("Everything is filled in. Ready to sign.")).toBeVisible();
  await page.getByRole("button", { name: "Finish and sign" }).click();
}
