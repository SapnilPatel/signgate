import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PASSWORD, activate, addAgreementFile, expect, go, test } from "../e2e/support";

/**
 * The host rejects request and response bodies above about 4.5 MB. This proves, on the
 * deployed site, that an agreement larger than that uploads (in chunks) and is served
 * back to the signer whole (streamed).
 */
function noisePng(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = size * 3 + 1;
  const raw = randomBytes(row * size); // noise does not compress, so the file stays large
  for (let y = 0; y < size; y++) raw[y * row] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

test("an agreement larger than the host's body limit uploads and is served back whole", async ({ office }) => {
  test.skip(!process.env.LIVE_URL || !process.env.SMTP_USER, "LIVE_URL and SMTP_USER are required");
  const id = Date.now().toString(36);
  const [local, domain] = (process.env.SMTP_USER ?? "").split("@");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([612, 792]);
  first.drawText("Large Client Agreement", { x: 72, y: 700, size: 18, font });
  first.drawText("Client signature: ______________________", { x: 72, y: 200, size: 12, font });
  const image = await doc.embedPng(noisePng(1500));
  doc.addPage([612, 792]).drawImage(image, { x: 56, y: 146, width: 500, height: 500 });
  const pdf = Buffer.from(await doc.save());
  expect(pdf.length).toBeGreaterThan(5 * 1024 * 1024);

  await go(office, "/signup");
  await office.getByLabel("Company name").fill(`Large Check ${id}`);
  await office.getByLabel("Your name").fill("Olivia Owner");
  await office.getByLabel("Work email").fill(`${local}+large${id}@${domain}`);
  await office.getByLabel("Password").fill(PASSWORD);
  await office.getByRole("button", { name: "Create account" }).click();
  await expect(office.getByRole("heading", { level: 1, name: /Welcome to Signgate/ })).toBeVisible({ timeout: 60_000 });

  const templateId = await addAgreementFile(office, { name: "large-client-agreement.pdf", mimeType: "application/pdf", buffer: pdf });
  await activate(office);

  const response = await office.request.get(`/api/app/templates/${templateId}/pdf`);
  expect(response.status()).toBe(200);
  const served = await response.body();
  console.log(`uploaded ${pdf.length} bytes, served ${served.length} bytes`);
  expect(served.subarray(0, 5).toString()).toBe("%PDF-");
  expect(served.length).toBeGreaterThan(5 * 1024 * 1024);
  expect((await PDFDocument.load(served)).getPageCount()).toBe(2);
});
