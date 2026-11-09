// R10 (owner order 2026-11-09), WO-I: opening what Trainee delivered, shared by the in-process acceptance suite
// (tests/architect/helpers/r10_world.ts) and the post-deploy live replay (scripts/launch/r10-live-replay.ts). No database, no
// fetch double: bytes in, findings out. A PDF is opened with the product's own reader (channel_resume_upload.ts fileText) and,
// where installed, poppler (pdftotext, pdfinfo); its page count, smallest font size and text placed outside the page are read
// from the file itself. A page is rendered in Chromium at 390 x 844 CSS px, deviceScaleFactor 2, under the Content-Security-
// Policy production serves it with, and screenshotted into R10_EVIDENCE_DIR.
import { deflateSync, inflateSync } from "node:zlib";
import { createRequire } from "node:module";

export const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
export const CI = Deno.env.get("CI") === "true";
export const EVIDENCE_DIR = Deno.env.get("R10_EVIDENCE_DIR") || `${ROOT}/artifacts/r10-acceptance`;
const enc = new TextEncoder();

// ------------------------------------------------------------------------------------------------ opening files
// A real PDF, one line per line (as flow-telegram-e2e.test.ts builds the person's upload).
export function pdfOf(text: string): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const ops = text.split("\n").map((l, i) => l.trim() ? `BT /F1 9 Tf 1 0 0 1 40 ${760 - i * 11} Tm (${esc(l)}) Tj ET` : "").filter(Boolean).join("\n");
  const stream = deflateSync(enc.encode(ops));
  const parts: Uint8Array[] = [], offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { parts.push(b); pos += b.length; };
  push(enc.encode("%PDF-1.4\n"));
  const objs: (string | Uint8Array)[][] = [["<< /Type /Catalog /Pages 2 0 R >>"], ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
    [`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, stream, "\nendstream"], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]];
  objs.forEach((o, i) => { offsets.push(pos); push(enc.encode(`${i + 1} 0 obj\n`)); for (const p of o) push(typeof p === "string" ? enc.encode(p) : p); push(enc.encode("\nendobj\n")); });
  const xref = pos;
  push(enc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(pos);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
function bytesIndexOf(h: Uint8Array, n: Uint8Array, from: number) {
  outer: for (let i = from; i <= h.length - n.length; i++) { for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer; return i; }
  return -1;
}
// The decoded content streams of a PDF (Flate or none), for font sizes and text positions.
function pdfStreams(b: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  const S = enc.encode("stream"), E = enc.encode("endstream");
  for (;;) {
    const s = bytesIndexOf(b, S, at);
    if (s < 0) break;
    const dictStart = latin1(b.subarray(Math.max(0, s - 400), s));
    let start = s + S.length;
    if (b[start] === 13) start++;
    if (b[start] === 10) start++;
    const e = bytesIndexOf(b, E, start);
    if (e < 0) break;
    const raw = b.subarray(start, e);
    const dict = dictStart.slice(dictStart.lastIndexOf("<<"));
    if (/\/FlateDecode/.test(dict)) { try { out.push(latin1(inflateSync(raw))); } catch { /* not a content stream we can read */ } }
    else if (!/\/Filter/.test(dict)) out.push(latin1(raw));
    at = e + E.length;
  }
  return out;
}
export interface PdfInspection { ok: boolean; pages: number; text: string; popplerText: string | null; minFontPt: number | null; outOfPage: number; media: number[] | null; why?: string }
// Opens a PDF: is it one (%PDF ... %%EOF), how many pages (the page tree's /Count, cross-checked by the /Type /Page objects and,
// when installed, pdfinfo), its text (the product's reader, and pdftotext when installed), the smallest font size set in its
// content streams, and how many text placements fall outside the page (a clipped line).
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const head = latin1(bytes.subarray(0, 8)), tail = latin1(bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (!head.startsWith("%PDF-") || !/%%EOF\s*$/.test(tail)) return { ok: false, pages: 0, text: "", popplerText: null, minFontPt: null, outOfPage: 0, media: null, why: "not a complete PDF (%PDF- ... %%EOF)" };
  const all = latin1(bytes);
  const pageObjs = (all.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const counts = [...all.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] ?? m[2]));
  let pages = counts.length ? Math.max(...counts) : pageObjs;
  const mb = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/.exec(all);
  const media = mb ? mb.slice(1, 5).map(Number) : null;
  let text = "";
  try {
    const { fileText } = await import("../../../supabase/functions/_shared/channel_resume_upload.ts");
    text = await fileText("pdf", bytes);
  } catch (e) { text = ""; console.log(`r10: the product's PDF reader could not read the file: ${(e as Error).message}`); }
  let popplerText: string | null = null;
  const tmp = await Deno.makeTempFile({ suffix: ".pdf" });
  try {
    await Deno.writeFile(tmp, bytes);
    try {
      const r = await new Deno.Command("pdftotext", { args: ["-layout", tmp, "-"], stdout: "piped", stderr: "null" }).output();
      if (r.success) popplerText = new TextDecoder().decode(r.stdout);
      const i = await new Deno.Command("pdfinfo", { args: [tmp], stdout: "piped", stderr: "null" }).output();
      const n = /Pages:\s+(\d+)/.exec(new TextDecoder().decode(i.stdout))?.[1];
      if (i.success && n) pages = Number(n);
    } catch { /* poppler not installed: the in-code reader stands */ }
  } finally { await Deno.remove(tmp).catch(() => {}); }
  if (!text.trim() && popplerText) text = popplerText;
  const sizes: number[] = [];
  let outOfPage = 0;
  for (const s of pdfStreams(bytes)) {
    for (const m of s.matchAll(/\/[\w.+-]+\s+([\d.]+)\s+Tf/g)) sizes.push(Number(m[1]));
    if (media) for (const m of s.matchAll(/([\d.\-]+)\s+([\d.\-]+)\s+(?:Td|TD)|1\s+0\s+0\s+1\s+([\d.\-]+)\s+([\d.\-]+)\s+Tm/g)) {
      const x = Number(m[1] ?? m[3]), y = Number(m[2] ?? m[4]);
      if (m[3] !== undefined && (x < media[0] || x > media[2] || y < media[1] || y > media[3])) outOfPage++;
    }
  }
  return { ok: true, pages, text, popplerText, minFontPt: sizes.filter((n) => n > 0).length ? Math.min(...sizes.filter((n) => n > 0)) : null, outOfPage, media };
}
// A DOCX's text (word/document.xml), by the product's own reader.
export async function inspectDocx(bytes: Uint8Array): Promise<{ ok: boolean; text: string; why?: string }> {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return { ok: false, text: "", why: "not a zip (DOCX) file" };
  try {
    const { fileText } = await import("../../../supabase/functions/_shared/channel_resume_upload.ts");
    return { ok: true, text: await fileText("docx", bytes) };
  } catch (e) { return { ok: false, text: "", why: (e as Error).message }; }
}
export async function saveFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = `${EVIDENCE_DIR}/files`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${name.replace(/[^\w.-]+/g, "_")}`;
  await Deno.writeFile(path, bytes);
  return path;
}

// ------------------------------------------------------------------------------------------------ rendering pages
export function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`, "/opt/node-tools/node_modules/playwright", "playwright"]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}
let browser: Promise<any> | null = null;
async function chromium(): Promise<any> {
  const pw = playwright();
  if (!pw) { if (CI) throw new Error("the R10 suite needs the gate's Playwright browser in CI"); return null; }
  const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
  browser ??= pw.chromium.launch(exe ? { executablePath: exe } : {});
  return await browser;
}
export async function closeBrowser() { if (browser) { const b = await browser.catch(() => null); browser = null; await b?.close().catch(() => {}); } }
export interface Rendered { screenshot: string | null; scrollWidth: number; innerWidth: number; innerHeight: number; text: string; probe: any }
// A page as a phone shows it: 390 x 844 CSS px at deviceScaleFactor 2, in light (and dark when asked), with nothing fetched
// from the network. `probe` runs in the page and returns whatever the check needs (boxes, styles).
export async function renderPhone(html: string, name: string, probe?: string, o: { scheme?: "light" | "dark"; csp?: string } = {}): Promise<Rendered> {
  const b = await chromium();
  if (!b) throw new Error("NOT_RUN: no Playwright browser on this machine");
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: o.scheme ?? "light" });
  try {
    const p = await ctx.newPage();
    // Served at its public address with the headers production serves it with (its CSP included), so what the browser
    // blocks there is blocked here too; every other request is refused.
    const at = "https://trainee.test/file";
    await p.route("**/*", (r: any) => r.request().url() === at
      ? r.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", ...(o.csp ? { "content-security-policy": o.csp } : {}) }, body: html })
      : r.abort());
    await p.goto(at, { waitUntil: "load" });
    const dir = `${EVIDENCE_DIR}/screens`;
    await Deno.mkdir(dir, { recursive: true });
    const shot = `${dir}/${name.replace(/[^\w.-]+/g, "_")}${o.scheme === "dark" ? "-dark" : ""}.png`;
    await p.screenshot({ path: shot, fullPage: true });
    const m = await p.evaluate(`(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, text: document.body ? document.body.innerText : "" }))()`);
    const pr = probe ? await p.evaluate(probe) : null;
    return { screenshot: shot, scrollWidth: m.sw, innerWidth: m.iw, innerHeight: m.ih, text: m.text, probe: pr };
  } finally { await ctx.close(); }
}

export interface OpenedPage { html: string | null; csp?: string }
export const renderOpened = (got: OpenedPage, name: string, probe?: string, o: { scheme?: "light" | "dark" } = {}) => renderPhone(got.html ?? "", name, probe, { ...o, csp: got.csp });
