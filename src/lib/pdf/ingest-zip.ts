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

/**
 * Private-use characters that carry paragraph formatting through the Word-to-HTML
 * step, which keeps text only. The typesetter reads them back (see typeset.ts).
 */
export const TAB_TO_OPEN = "\ue000";
export const TAB_TO_CLOSE = "\ue001";
export const ALIGN_MARK = "\ue002";

/**
 * Rewrites one paragraph so its layout survives conversion: leader tabs become the
 * characters Word would draw, tabs to a custom stop say where they stop, and a centred
 * or right-aligned paragraph says so.
 */
function rewriteParagraph(xml: string): string {
  const props = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(xml);
  const jc = props ? /<w:jc\s+w:val="(center|right|end)"/.exec(props[0])?.[1] : undefined;
  if (props && jc && /<w:t[ >]/.test(xml)) {
    const at = props.index + props[0].length;
    xml = `${xml.slice(0, at)}<w:r><w:t>${ALIGN_MARK}${jc === "center" ? "c" : "r"}</w:t></w:r>${xml.slice(at)}`;
  }
  const tabs = /<w:tabs>([\s\S]*?)<\/w:tabs>/.exec(xml);
  if (!tabs) return xml;
  const stops: { fill: string | undefined; pos: number; left: boolean }[] = [];
  for (const m of tabs[1].matchAll(/<w:tab\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (/w:val="clear"/.test(attrs)) continue;
    const leader = /w:leader="(\w+)"/.exec(attrs)?.[1];
    const pos = Number(/w:pos="(-?\d+)"/.exec(attrs)?.[1] ?? "0");
    stops.push({ fill: leader ? LEADER_CHARS[leader] : undefined, pos, left: /w:val="(left|start)"/.test(attrs) });
  }
  if (stops.length === 0) return xml;
  stops.sort((a, b) => a.pos - b.pos);
  const head = xml.slice(0, tabs.index + tabs[0].length);
  const rest = xml.slice(head.length);
  let index = 0;
  const body = rest.replace(/<w:tab\s*\/>/g, (tab, offset: number) => {
    const stop = stops[index];
    const previous = index > 0 ? stops[index - 1].pos : (stop?.pos ?? 0) * 0.3;
    index += 1;
    if (!stop) return tab;
    if (!stop.fill) {
      // An underlined tab is a line to sign on and is handled as one; any other tab to a
      // left stop keeps its position, so "Date" still lands under its own blank.
      const run = rest.slice(Math.max(0, rest.lastIndexOf("<w:r>", offset), rest.lastIndexOf("<w:r ", offset)), offset);
      if (!stop.left || stop.pos <= 0 || /<w:u\b(?![^>]*w:val="none")/.test(run)) return tab;
      return `<w:t>${TAB_TO_OPEN}${Math.round(stop.pos / 20)}${TAB_TO_CLOSE}</w:t>`;
    }
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
 * so it is lost in conversion and the signature line with it. Custom tab stops and
 * centred paragraphs are lost the same way. This rewrites all three into the text
 * before conversion. On any problem the original bytes are
 * returned unchanged: this is an improvement, never a reason to fail an upload.
 */
export async function applyTabLeaders(docx: Uint8Array): Promise<Uint8Array> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(docx);
    const part = zip.file("word/document.xml");
    if (!part) return docx;
    const xml = await part.async("string");
    if (!xml.includes("<w:tabs>") && !xml.includes("<w:jc ")) return docx;
    const rewritten = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, rewriteParagraph);
    if (rewritten === xml) return docx;
    zip.file("word/document.xml", rewritten);
    return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  } catch {
    return docx;
  }
}
