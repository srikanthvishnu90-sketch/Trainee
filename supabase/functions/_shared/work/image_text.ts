// WO-124a fourteenth review (D-088): the text a PNG or JPEG carries, read by allow-list. Every chunk or segment is either
// known to hold no text (pixels, colour and layout data), or is a text-bearing one that is read in full (PNG tEXt, zTXt and
// iTXt inflated, iCCP's profile inflated, eXIf; JPEG Exif, XMP, extended XMP, ICC profile, Photoshop resources, comments). Anything else, a
// bad CRC, a bad length, or bytes after the end, returns null: the caller reports the image as unreadable (fail closed).
import zlib from "node:zlib";

export interface ImageRead { texts: string[]; inner: Uint8Array[] }

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);
const startsWith = (b: Uint8Array, s: string) => s.length <= b.length && [...s].every((c, i) => b[i] === c.charCodeAt(0));
const cat = (a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const inflate = (b: Uint8Array) => new Uint8Array(zlib.inflateSync(b, { maxOutputLength: 64 * 1024 * 1024 } as never));
// Bytes of unknown text encoding are read every likely way; a wrong decoding only costs a non-match.
const anyText = (b: Uint8Array) => [latin1(b), utf8(b), new TextDecoder("utf-16le").decode(b), new TextDecoder("utf-16be").decode(b)];

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const be32 = (b: Uint8Array, i: number) => { if (i < 0 || i + 4 > b.length) throw new RangeError("short"); return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; };
const be16 = (b: Uint8Array, i: number) => { if (i < 0 || i + 2 > b.length) throw new RangeError("short"); return (b[i] << 8) | b[i + 1]; };

export const isPng = (b: Uint8Array) => b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x);
export const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isGif = (b: Uint8Array) => startsWith(b, "GIF8");

// PNG chunks that hold no text: image header, palette, pixels, transparency, colour and timing data, APNG frames, Apple's
// iDOT decode hints.
const PNG_NO_TEXT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "sBIT", "sRGB", "pHYs", "bKGD", "hIST", "tIME", "cICP", "mDCV", "cLLI", "acTL", "fcTL", "fdAT", "iDOT"]);
export function pngText(b: Uint8Array): ImageRead | null {
  if (!isPng(b)) return null;
  const out: ImageRead = { texts: [], inner: [] };
  try {
    let p = 8, ended = false;
    while (p < b.length) {
      if (ended) return null; // bytes after IEND
      const len = be32(b, p), type = latin1(b.subarray(p + 4, p + 8));
      if (p + 12 + len > b.length || len > 0x7fffffff) return null;
      const data = b.subarray(p + 8, p + 8 + len);
      if (be32(b, p + 8 + len) !== crc32(b.subarray(p + 4, p + 8 + len))) return null;
      p += 12 + len;
      const nul = data.indexOf(0), key = nul < 0 ? null : data.subarray(0, nul);
      if (type === "IEND") ended = true;
      if (PNG_NO_TEXT.has(type)) continue;
      if (type === "tEXt") { out.texts.push(latin1(data)); continue; }
      if (type === "eXIf") { if (!exif(data, out)) return null; continue; }
      if (!key) return null;
      if (type === "zTXt") { if (data[nul + 1] !== 0) return null; out.texts.push(latin1(key), latin1(inflate(data.subarray(nul + 2)))); continue; }
      if (type === "iTXt") {
        const flag = data[nul + 1], method = data[nul + 2];
        const l = data.indexOf(0, nul + 3); if (l < 0) return null;
        const t = data.indexOf(0, l + 1); if (t < 0) return null;
        if (flag !== 0 && (flag !== 1 || method !== 0)) return null;
        const body = data.subarray(t + 1);
        out.texts.push(latin1(key), latin1(data.subarray(nul + 3, l)), utf8(data.subarray(l + 1, t)), utf8(flag ? inflate(body) : body));
        continue;
      }
      if (type === "iCCP") { if (data[nul + 1] !== 0) return null; out.texts.push(latin1(key), ...anyText(inflate(data.subarray(nul + 2)))); continue; }
      if (type === "sPLT") { out.texts.push(latin1(key)); continue; }
      return null; // an unknown chunk
    }
    return ended ? out : null;
  } catch {
    return null;
  }
}

// A TIFF/EXIF block: every IFD (0th, Exif, GPS, Interop, 1st) is walked; each text-like value (ASCII, BYTE, UNDEFINED,
// SBYTE, which hold comments, captions, the Windows XP* tags and maker notes) is read; a thumbnail is returned to be read as
// an image of its own. Numeric values are not text. An unknown type, an out-of-range offset or a loop is unreadable.
const TIFF_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
function exif(t: Uint8Array, out: ImageRead): boolean {
  if (t.length < 8) return false;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return false;
  const r16 = (i: number) => { if (i < 0 || i + 2 > t.length) throw new RangeError("short"); return le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]; };
  const r32 = (i: number) => le ? r16(i) + r16(i + 2) * 65536 : r16(i) * 65536 + r16(i + 2);
  if (r16(2) !== 42) return false;
  const seen = new Set<number>(), queue = [r32(4)];
  let thumbOff = -1, thumbLen = -1;
  while (queue.length) {
    const off = queue.shift()!;
    if (off === 0) continue;
    if (seen.has(off) || seen.size > 32) return false;
    seen.add(off);
    const n = r16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + 12 * k, tag = r16(e), type = r16(e + 2), count = r32(e + 4), size = TIFF_SIZE[type];
      if (!size) return false;
      const len = size * count, at = len <= 4 ? e + 8 : r32(e + 8);
      if (at + len > t.length) return false;
      const scalar = type === 3 ? r16(e + 8) : r32(e + 8);
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) { queue.push(scalar); continue; }
      if (tag === 0x014a) return false; // SubIFDs: further images
      if (tag === 0x0201) thumbOff = scalar;
      if (tag === 0x0202) thumbLen = scalar;
      if (type === 2) out.texts.push(latin1(t.subarray(at, at + len)));
      else if (type === 1 || type === 6 || type === 7) out.texts.push(...anyText(t.subarray(at, at + len)));
    }
    queue.push(r32(off + 2 + 12 * n));
  }
  if (thumbOff >= 0 || thumbLen >= 0) {
    if (thumbOff < 0 || thumbLen < 0 || thumbOff + thumbLen > t.length) return false;
    out.inner.push(t.subarray(thumbOff, thumbOff + thumbLen));
  }
  return true;
}

// A Photoshop image-resource block (JPEG APP13, which Office writes into its thumbnails): each resource is known by id.
// IPTC records, URL lists and version strings are text, read as such; Exif, XMP and ICC are read as above; a thumbnail is
// returned as an image of its own; resolution, print, guide, angle, seed and digest records hold no text. Any other id is
// unreadable.
const IRB_TEXT = new Set([0x0404, 0x041e, 0x0421, 0x040f]), IRB_NO_TEXT = new Set([0x03ed, 0x03f3, 0x0406, 0x0408, 0x040d, 0x0414, 0x0419, 0x0425]);
function irb(seg: Uint8Array, out: ImageRead): boolean {
  let q = 0;
  while (q < seg.length) {
    if (q + 12 > seg.length || !startsWith(seg.subarray(q), "8BIM")) return false;
    const id = be16(seg, q + 4), nl = seg[q + 6];
    out.texts.push(latin1(seg.subarray(q + 7, q + 7 + nl)));
    const r = q + 6 + ((1 + nl) % 2 ? 2 + nl : 1 + nl), size = be32(seg, r), data = seg.subarray(r + 4, r + 4 + size);
    if (r + 4 + size > seg.length) return false;
    q = r + 4 + size + (size % 2);
    if (IRB_NO_TEXT.has(id)) continue;
    if (IRB_TEXT.has(id)) { out.texts.push(...anyText(data)); continue; }
    if (id === 0x0422) { if (!exif(data, out)) return false; continue; }
    if (id === 0x0424) { out.texts.push(utf8(data)); continue; }
    if (id === 0x0409 || id === 0x040c) { if (size < 28) return false; out.inner.push(data.subarray(28)); continue; }
    return false;
  }
  return true;
}

const XMP = "http://ns.adobe.com/xap/1.0/\0", XMP_EXT = "http://ns.adobe.com/xmp/extension/\0";
export function jpegText(b: Uint8Array): ImageRead | null {
  if (!isJpeg(b)) return null;
  const out: ImageRead = { texts: [], inner: [] }, icc: Uint8Array[] = [], ext: Uint8Array[] = [];
  try {
    let p = 2;
    for (;;) {
      if (p >= b.length || b[p] !== 0xff) return null;
      while (b[p] === 0xff) p++;
      if (p >= b.length) return null;
      const mk = b[p++];
      if (mk === 0xd9) break; // EOI
      if ((mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) continue;
      const len = be16(b, p);
      if (len < 2 || p + len > b.length) return null;
      const seg = b.subarray(p + 2, p + len);
      p += len;
      if ((mk >= 0xc0 && mk <= 0xcf && mk !== 0xc8) || mk === 0xdb || mk === 0xdc || mk === 0xdd) continue; // frame, tables
      if (mk === 0xda) { // scan: entropy-coded data runs to the next marker that is not a stuffed byte or a restart
        while (p < b.length && !(b[p] === 0xff && p + 1 < b.length && b[p + 1] !== 0x00 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
        continue;
      }
      if (mk === 0xe0 && startsWith(seg, "JFIF\0")) continue; // its optional thumbnail is raw pixels
      if (mk === 0xe1 && startsWith(seg, "Exif\0\0")) { if (!exif(seg.subarray(6), out)) return null; continue; }
      if (mk === 0xe1 && startsWith(seg, XMP)) { out.texts.push(utf8(seg.subarray(XMP.length))); continue; }
      if (mk === 0xe1 && startsWith(seg, XMP_EXT)) { if (seg.length < XMP_EXT.length + 40) return null; ext.push(seg.subarray(XMP_EXT.length + 40)); continue; }
      if (mk === 0xe2 && startsWith(seg, "ICC_PROFILE\0")) { if (seg.length < 14) return null; icc.push(seg.subarray(14)); continue; }
      if (mk === 0xed && startsWith(seg, "Photoshop 3.0\0")) { if (!irb(seg.subarray(14), out)) return null; continue; }
      if (mk === 0xee && startsWith(seg, "Adobe")) continue; // colour transform flags
      if (mk === 0xfe) { out.texts.push(...anyText(seg)); continue; }
      return null; // any other APPn (MPF, Photoshop IRB, JFXX ...) or an unknown marker
    }
    for (let i = p; i < b.length; i++) if (b[i] !== 0) return null; // bytes after EOI (zero padding aside)
  } catch {
    return null;
  }
  if (icc.length) out.texts.push(...anyText(cat(icc)));
  if (ext.length) out.texts.push(utf8(cat(ext)));
  return out;
}
