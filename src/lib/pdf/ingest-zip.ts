/**
 * Zip helpers for Office files. Listing entry names needs no decompression, which
 * is how an upload is told apart (Word vs Excel vs PowerPoint) cheaply and safely.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

const MAX_ENTRIES = 5000;

function readName(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, start + Math.min(length, 1024));
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Entry names and sizes from the central directory, or from local headers when the archive is cut short. */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  try {
    // The end-of-central-directory record sits at the end, before an optional comment of up to 64 KB.
    const stop = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= stop; i--) {
      if (view.getUint32(i, true) !== 0x06054b50) continue;
      let pos = view.getUint32(i + 16, true);
      const count = view.getUint16(i + 10, true);
      for (let n = 0; n < count && n < MAX_ENTRIES && pos + 46 <= bytes.length; n++) {
        if (view.getUint32(pos, true) !== 0x02014b50) break;
        const nameLength = view.getUint16(pos + 28, true);
        entries.push({
          name: readName(bytes, pos + 46, nameLength),
          compressedSize: view.getUint32(pos + 20, true),
          uncompressedSize: view.getUint32(pos + 24, true),
        });
        pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
      }
      if (entries.length > 0) return entries;
      break;
    }
    // No usable directory (truncated upload): walk the local file headers instead.
    let pos = 0;
    while (pos + 30 <= bytes.length && entries.length < MAX_ENTRIES) {
      if (view.getUint32(pos, true) !== 0x04034b50) break;
      const compressedSize = view.getUint32(pos + 18, true);
      const nameLength = view.getUint16(pos + 26, true);
      entries.push({ name: readName(bytes, pos + 30, nameLength), compressedSize, uncompressedSize: view.getUint32(pos + 22, true) });
      pos += 30 + nameLength + view.getUint16(pos + 28, true) + compressedSize;
    }
  } catch {
    // A malformed archive yields whatever was listed before the bad record.
  }
  return entries;
}

const LEADER_CHARS: Record<string, string> = { underscore: "_", heavy: "_", dot: ".", middleDot: ".", hyphen: "-" };

/** Rewrites the tabs of one paragraph that has leader tab stops into the characters Word would draw. */
function rewriteParagraph(xml: string): string {
  const tabs = /<w:tabs>([\s\S]*?)<\/w:tabs>/.exec(xml);
  if (!tabs || !tabs[1].includes("w:leader")) return xml;
  const stops: { fill: string | undefined; pos: number }[] = [];
  for (const m of tabs[1].matchAll(/<w:tab\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (/w:val="clear"/.test(attrs)) continue;
    const leader = /w:leader="(\w+)"/.exec(attrs)?.[1];
    const pos = Number(/w:pos="(-?\d+)"/.exec(attrs)?.[1] ?? "0");
    stops.push({ fill: leader ? LEADER_CHARS[leader] : undefined, pos });
  }
  stops.sort((a, b) => a.pos - b.pos);
  const head = xml.slice(0, tabs.index + tabs[0].length);
  let index = 0;
  const body = xml.slice(head.length).replace(/<w:tab\s*\/>/g, (tab) => {
    const stop = stops[index];
    const previous = index > 0 ? stops[index - 1].pos : (stop?.pos ?? 0) * 0.3;
    index += 1;
    if (!stop?.fill) return tab;
    // Positions are in twentieths of a point; an underscore is about 5.5 pt wide at body size.
    const points = Math.max(0, stop.pos - previous) / 20;
    const count = Math.min(60, Math.max(6, Math.round(points / 5.5)));
    return `<w:t>${stop.fill.repeat(count)}</w:t>`;
  });
  return head + body;
}

/**
 * Word draws many signature lines as a tab with a "leader" (a tab stop that fills
 * its gap with underscores or dots). The leader is paragraph formatting, not text,
 * so it is lost in conversion and the signature line with it. This rewrites such
 * tabs as real characters before conversion. On any problem the original bytes are
 * returned unchanged: this is an improvement, never a reason to fail an upload.
 */
export async function applyTabLeaders(docx: Uint8Array): Promise<Uint8Array> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(docx);
    const part = zip.file("word/document.xml");
    if (!part) return docx;
    const xml = await part.async("string");
    if (!xml.includes("w:leader=")) return docx;
    const rewritten = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, rewriteParagraph);
    if (rewritten === xml) return docx;
    zip.file("word/document.xml", rewritten);
    return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  } catch {
    return docx;
  }
}
