// KNOWN GAPS (2026-10-30, #317): resume PDFs whose text is written as HEX strings, as people's PDFs are:
//   simple  a one-byte font (Helvetica) with "<44617461...> Tj" strings
//   cid     a Type0 font with Identity-H (two-byte codes, as Word, Google Docs and most embedded fonts write) and its
//           ToUnicode CMap (bfchar and bfrange), lines as hex Tj and as TJ arrays of hex strings with kerning between words
//   nomap   the same Type0 font with NO ToUnicode: its codes are glyph ids, so no text can be read (honestly "may be a scan")
// Deterministic: the bytes are the same every run (tests/fixtures/known-gaps/resume-cid-hex.pdf is the cid one, written by
// this builder and checked against it).
import { deflateSync } from "node:zlib";

export const HEX_RESUME_LINES = [
  "TEST Hexa Person",
  "EXPERIENCE",
  "Data Analyst Intern, TEST Hex Co",
  "- Built TEST dashboards in SQL for the sales team",
  "- Cut the weekly report from two days to one hour",
  "EDUCATION",
  "TEST University - B.S. Economics, May 2026",
  "SKILLS",
  "SQL, Python, Excel, Tableau",
];
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

function assemble(objs: (string | { dict: string; stream: Uint8Array })[]): Uint8Array {
  const chunks: Uint8Array[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let pos = chunks[0].length;
  const push = (b: Uint8Array) => { chunks.push(b); pos += b.length; };
  objs.forEach((o, i) => {
    offsets.push(pos);
    if (typeof o === "string") push(latin1(`${i + 1} 0 obj\n${o}\nendobj\n`));
    else { push(latin1(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.stream.length} /Filter /FlateDecode >>\nstream\n`)); push(o.stream); push(latin1("\nendstream\nendobj\n")); }
  });
  const xref = pos;
  push(latin1(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function hexResumePdf(kind: "simple" | "cid" | "nomap", lines: string[] = HEX_RESUME_LINES): Uint8Array {
  // Two-byte codes for the cid fonts: each distinct character its own code, from 0x0003 (as a subset font numbers glyphs).
  const chars = [...new Set(lines.join(""))].sort();
  const code = new Map(chars.map((c, i) => [c, 3 + i]));
  const enc = (t: string) => kind === "simple" ? [...t].map((c) => hex2(c.charCodeAt(0))).join("") : [...t].map((c) => hex4(code.get(c)!)).join("");
  const ops = lines.map((l, i) => {
    const y = 740 - i * 16;
    // Every third line as a TJ array: one hex string per word, a word-wide kerning between them.
    const body = i % 3 === 2 ? `[${l.split(" ").map((w, k, ws) => `<${enc(w)}>${k < ws.length - 1 ? " -278" : ""}`).join(" ")}] TJ` : `<${enc(l)}> Tj`;
    return `BT /F1 11 Tf 1 0 0 1 54 ${y} Tm ${body} ET`;
  }).join("\n");
  const content = { dict: "", stream: new Uint8Array(deflateSync(latin1(ops))) };
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  const head = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page, content];
  if (kind === "simple") return assemble([...head, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
  // The ToUnicode CMap: letters by one bfrange where codes and characters both run on (a..z when all present), the rest by bfchar.
  const single: string[] = [], ranges: string[] = [];
  let k = 0;
  while (k < chars.length) {
    let j = k;
    while (j + 1 < chars.length && chars[j + 1].charCodeAt(0) === chars[j].charCodeAt(0) + 1) j++;
    if (j - k >= 2) ranges.push(`<${hex4(code.get(chars[k])!)}> <${hex4(code.get(chars[j])!)}> <${hex4(chars[k].charCodeAt(0))}>`);
    else for (let x = k; x <= j; x++) single.push(`<${hex4(code.get(chars[x])!)}> <${hex4(chars[x].charCodeAt(0))}>`);
    k = j + 1;
  }
  const cmap = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap", "/CMapName /TEST-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange",
    `${single.length} beginbfchar`, ...single, "endbfchar", `${ranges.length} beginbfrange`, ...ranges, "endbfrange",
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"].join("\n");
  const type0 = `<< /Type /Font /Subtype /Type0 /BaseFont /TESTSans /Encoding /Identity-H /DescendantFonts [6 0 R]${kind === "cid" ? " /ToUnicode 7 0 R" : ""} >>`;
  const cidFont = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TESTSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>";
  return assemble([...head, type0, cidFont, ...(kind === "cid" ? [{ dict: "", stream: new Uint8Array(deflateSync(latin1(cmap))) }] : [])]);
}
