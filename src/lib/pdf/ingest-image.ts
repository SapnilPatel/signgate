/** Header parsing for PNG and JPEG: pixel size and camera orientation, without decoding the picture. */

export interface PixelSize {
  width: number;
  height: number;
}

export function pngSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null; // "IHDR"
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Reads the EXIF orientation (1..8) from an APP1 segment body, or 1 when absent or malformed. */
function exifOrientation(view: DataView, start: number, end: number): number {
  // "Exif\0\0" then a TIFF header.
  if (end - start < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return 1;
  const tiff = start + 6;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

export function jpegInfo(bytes: Uint8Array): { size: PixelSize | null; orientation: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation = 1;
  let pos = 2;
  try {
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      const marker = bytes[pos + 1];
      // Fill bytes and markers without a length.
      if (marker === 0xff) {
        pos += 1;
        continue;
      }
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9) break;
      const length = view.getUint16(pos + 2);
      if (length < 2) break;
      const bodyStart = pos + 4;
      const bodyEnd = Math.min(bytes.length, pos + 2 + length);
      if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(view, bodyStart, bodyEnd);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame && bodyStart + 5 <= bytes.length) {
        return { size: { height: view.getUint16(bodyStart + 1), width: view.getUint16(bodyStart + 3) }, orientation };
      }
      // Compressed data follows a scan header; the frame header always comes before it.
      if (marker === 0xda) break;
      pos += 2 + length;
    }
  } catch {
    // Out-of-range read on a truncated file.
  }
  return { size: null, orientation };
}

interface Orientation {
  s0: number;
  su: number;
  sv: number;
  t0: number;
  tu: number;
  tv: number;
}

/**
 * For each EXIF orientation, how a point (u, v) of the stored image (u right, v up,
 * both 0..1) maps to the upright picture: s = s0 + su*u + sv*v, t = t0 + tu*u + tv*v.
 */
export const ORIENTATION_MATRIX: Record<number, Orientation> = {
  1: { s0: 0, su: 1, sv: 0, t0: 0, tu: 0, tv: 1 },
  2: { s0: 1, su: -1, sv: 0, t0: 0, tu: 0, tv: 1 },
  3: { s0: 1, su: -1, sv: 0, t0: 1, tu: 0, tv: -1 },
  4: { s0: 0, su: 1, sv: 0, t0: 1, tu: 0, tv: -1 },
  5: { s0: 1, su: 0, sv: -1, t0: 1, tu: -1, tv: 0 },
  6: { s0: 0, su: 0, sv: 1, t0: 1, tu: -1, tv: 0 },
  7: { s0: 0, su: 0, sv: 1, t0: 0, tu: 1, tv: 0 },
  8: { s0: 1, su: 0, sv: -1, t0: 0, tu: 1, tv: 0 },
};
