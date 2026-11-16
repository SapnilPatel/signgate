/**
 * Copies the PDF.js worker and its data files into public/pdfjs so the browser
 * loads them from our own origin, at exactly the installed version. Runs after
 * every install (including on the host), so the copies are never committed and
 * can never drift from the library.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "pdfjs-dist");
const dest = path.join(root, "public", "pdfjs");

if (!existsSync(src)) {
  console.log("copy-pdf-assets: pdfjs-dist is not installed yet, skipping");
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// The legacy build runs on older phones, which is where clients sign.
cpSync(path.join(src, "legacy", "build", "pdf.worker.min.mjs"), path.join(dest, "pdf.worker.min.mjs"));
// Character maps and fallback fonts for PDFs that do not embed their own; image
// decoders (JBIG2, JPEG 2000) and colour profiles that scanned agreements rely on.
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  if (existsSync(path.join(src, dir))) cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
}
console.log("copy-pdf-assets: public/pdfjs is up to date");
