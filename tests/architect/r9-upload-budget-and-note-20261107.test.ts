// Greptile on #583 (release 8), fixed after the release.
// P1: the Word checks (the hidden reader, the clean copy, an embedded Word file) read each part with its own call, and the zip
// reader's size cap started again at each call, so a small upload of hundreds of highly compressed parts, each under the
// per-part cap, expanded to hundreds of MB. One budget per upload now covers every part read; past it the upload is refused
// as damaged, quickly, and the worker never crashes.
// P2: the early code-in-chat pass dropped what it removed; while a code is pending the later pass finds nothing new, so the
// reply's note missed the removal.
import assertNode from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { cleanCopy, docxHiddenText, FILE_DAMAGED_REPLY, ingestResumeFile, UploadBudget } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";

const enc = new TextEncoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const BODY = ["Jordan Lee", "Experience", "Operations Analyst, Acme Corp, 2019 - 2024", "Led weekly reporting across four teams and cut close time by two days.",
  "Built a customer portal serving 120000 customers.", "Education", "BS Economics, State University, 2019", "Skills", "SQL, Excel, Tableau"];
const DOC = `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${BODY.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

// A zip whose repeated parts share one deflated body and checksum, so building 400 MB of parts costs one deflate.
function zipWith(lead: { name: string; data: Uint8Array }[], repeated: { prefix: string; data: Uint8Array; count: number } | null): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff], u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const entries: { name: string; comp: Uint8Array; crc: number; size: number }[] = lead.map((e) => ({ name: e.name, comp: new Uint8Array(deflateRawSync(e.data)), crc: crc32(e.data), size: e.data.length }));
  if (repeated) {
    const comp = new Uint8Array(deflateRawSync(repeated.data)), crc = crc32(repeated.data);
    for (let i = 1; i <= repeated.count; i++) entries.push({ name: `${repeated.prefix}${i}.xml`, comp, crc, size: repeated.data.length });
  }
  const chunks: Uint8Array[] = [], central: number[] = [];
  let off = 0;
  for (const e of entries) {
    const name = [...enc.encode(e.name)];
    const head = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.comp.length), ...u32(e.size), ...u16(name.length), ...u16(0), ...name]);
    chunks.push(head, e.comp);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.comp.length), ...u32(e.size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name);
    off += head.length + e.comp.length;
  }
  chunks.push(new Uint8Array(central), new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(off), ...u16(0)]));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
const base = [{ name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') }, { name: "word/document.xml", data: enc.encode(DOC) }];
const MB = 1024 * 1024;
const text1mb = enc.encode(`<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>${"a".repeat(MB - 200)}</w:t></w:r></w:p></w:hdr>`);
const ingest = (bytes: Uint8Array) => ingestResumeFile({
  userId: "u1", channel: "telegram", doc: { fileId: "f1", uniqueId: "u-f1", name: "resume.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: bytes.length },
  fetchFile: async () => ({ ok: true as const, bytes }), record: async () => { throw new Error("nothing is stored on a refusal"); },
});

Deno.test("R9-1 a small upload of 400 highly compressed 1 MB text parts is refused as damaged, quickly", async () => {
  const bytes = zipWith(base, { prefix: "word/header", data: text1mb, count: 400 });
  assertNode.ok(bytes.length < 2 * MB, `the upload is small (${bytes.length} bytes)`);
  const t0 = performance.now();
  await assertNode.rejects(docxHiddenText(bytes), /budget/, "the hidden reader stops at the upload budget");
  const res = await ingest(bytes);
  const ms = performance.now() - t0;
  assertNode.equal(res.ok, false);
  assertNode.equal((res as { reply: string }).reply, FILE_DAMAGED_REPLY);
  assertNode.equal((res as { why: string }).why, "damaged");
  assertNode.ok(ms < 5000, `refused in ${Math.round(ms)} ms`);
});

Deno.test("R9-2 a structural part counts too, and more than 2,000 parts is refused", async () => {
  await assertNode.rejects(docxHiddenText(zipWith(base, { prefix: "customXml/item", data: text1mb, count: 400 })), /budget/, "skipped parts are still expanded, so they count");
  const many = zipWith(base, { prefix: "word/footnotes", data: enc.encode(`<w:ftr xmlns:w="${W}"/>`), count: 2100 });
  await assertNode.rejects(docxHiddenText(many), /too many parts/);
  assertNode.equal((await ingest(many) as { reply: string }).reply, FILE_DAMAGED_REPLY);
});

Deno.test("R9-3 one budget is shared by the hidden reader and the clean copy, and the upload passes the same one to both", async () => {
  // Four 64 KB headers the document references: the hidden reader reads them, and the clean copy reads them again.
  const K = 64 * 1024, n = 4;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${i + 1}.xml"/>`).join("")}</Relationships>`;
  const refs = Array.from({ length: n }, (_, i) => `<w:headerReference w:type="${i ? "even" : "default"}" r:id="rId${i + 1}"/>`).join("");
  const doc = DOC.replace(`xmlns:w="${W}"`, `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`).replace("</w:body>", `<w:sectPr>${refs}</w:sectPr></w:body>`);
  const bytes = zipWith([base[0], { name: "word/document.xml", data: enc.encode(doc) }, { name: "word/_rels/document.xml.rels", data: enc.encode(rels) }],
    { prefix: "word/header", data: enc.encode(`<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>${"a".repeat(K - 200)}</w:t></w:r></w:p></w:hdr>`), count: n });
  const hidden = new UploadBudget(), clean = new UploadBudget();
  await docxHiddenText(bytes, hidden);
  await cleanCopy(bytes, clean);
  assertNode.ok(hidden.bytes > n * K - 1024 && clean.bytes > n * K - 1024, `each reads the headers (${hidden.bytes}, ${clean.bytes})`);
  const cap = Math.max(hidden.bytes, clean.bytes) + 1024;
  assertNode.ok(hidden.bytes + clean.bytes > cap, "together over this budget, each alone under it");
  const shared = new UploadBudget(cap);
  await docxHiddenText(bytes, shared);
  await assertNode.rejects(cleanCopy(bytes, shared), /budget/, "the clean copy spends what the hidden reader left");
  const src = await Deno.readTextFile(new URL("../../supabase/functions/_shared/channel_resume_upload.ts", import.meta.url));
  const ing = src.slice(src.indexOf("export async function ingestResumeFile"));
  assertNode.match(ing, /const budget = new UploadBudget\(\);/);
  assertNode.match(ing, /docxHiddenText\(got\.bytes, budget\)/);
  assertNode.match(ing, /cleanCopy\(got\.bytes, budget\)/);
});

Deno.test("R9-4 the plain real Word files still pass within the budget", async () => {
  for (const name of ["libreoffice-pandoc.docx", "libreoffice-pydocx.docx", "pandoc-plain.docx", "pydocx-plain.docx"]) {
    const bytes = await Deno.readFile(new URL(`./fixtures/r8-real-docx/${name}`, import.meta.url));
    const budget = new UploadBudget();
    await docxHiddenText(bytes, budget);
    await cleanCopy(bytes, budget);
    assertNode.ok(budget.bytes > 0 && budget.bytes < 25 * MB && budget.parts < 2000, `${name}: ${budget.bytes} bytes, ${budget.parts} parts`);
  }
});

Deno.test("R9-5 while a code is pending, only the early pass removes it; the handler records that removal", async () => {
  const early = codeInChat("Workday sent me 739201", { codePending: true });
  assertNode.ok(early && early.text.includes("[code removed]") && early.removed.includes("code"), "the early pass removes the code");
  assertNode.equal(codeInChat(early!.text, { removed: [], codePending: true }), null, "the later pass finds nothing new");
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const at = (re: RegExp) => { const m = re.exec(src); assertNode.ok(m, `missing: ${re}`); return m!.index; };
  const earlyAt = at(/const early = codeInChat\(message,/);
  const merge = at(/removedNow = \[\.\.\.new Set\(\[\.\.\.removedNow, \.\.\.early\.removed\]\)\];/);
  const later = at(/const codeShared = fileText \? null : codeInChat\(message,/);
  const block = src.slice(earlyAt, later);
  assertNode.ok(earlyAt < merge && merge < later, "early.removed is merged into removedNow before the later pass");
  assertNode.match(block, /flowCtx\.note = redactionNote\(removedNow\);/, "the note is refreshed from removedNow");
  assertNode.match(block, /PAY_BY_CHECKOUT/, "the card and account sentence is kept, as the later pass does");
  assertNode.ok(at(/const hashedMessage = message;/) > later, "the request hash is still taken after every pass");
});

Deno.test("R9B-dup a Word file naming one part twice is refused before any part is read (Greptile on #584)", async () => {
  const { docxHiddenText } = await import("../../supabase/functions/_shared/channel_resume_upload.ts");
  const { zipOf } = await import("./scenarios/onboarding-r2-generator.ts");
  const enc = new TextEncoder();
  const doc = enc.encode('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jordan Lee</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  const hdr = (t: string) => enc.encode(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:hdr>`);
  const dup = zipOf([{ name: "word/document.xml", data: doc }, { name: "word/header1.xml", data: hdr("a") }, { name: "word/header1.xml", data: hdr("b") }]);
  const caseDup = zipOf([{ name: "word/document.xml", data: doc }, { name: "word/header1.xml", data: hdr("a") }, { name: "WORD/Header1.xml", data: hdr("b") }]);
  for (const [bytes, tag] of [[dup, "exact"], [caseDup, "case"]] as const) {
    let threw = false;
    try { await docxHiddenText(bytes); } catch { threw = true; }
    if (!threw) throw new Error(`a part named twice (${tag}) must refuse`);
  }
  // one name each still reads
  await docxHiddenText(zipOf([{ name: "word/document.xml", data: doc }, { name: "word/header1.xml", data: hdr("a") }]));
});
