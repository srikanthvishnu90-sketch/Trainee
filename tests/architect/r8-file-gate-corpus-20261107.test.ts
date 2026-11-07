// Release 8 file gate, fixed corpus (owner decision on a7b76b6f): every hand-over the five independent reviews of #575 showed,
// and the fifth review's 351 realistic resume lines, through the real DOCX upload path. A hand-over refuses the upload, stores
// nothing and the reply never repeats the line or the code; a harmless line is kept and the file is stored once.
import assertNode from "node:assert/strict";
import { ingestResumeFile } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { DOCX, docxBytes } from "./scenarios/onboarding-r2-generator.ts";
import { fileCodeLines } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";

const corpus = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/r8-file-gate.json", import.meta.url))) as { handover: Record<string, string[]>; harmless: string[] };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join(""));
const BODY = ["Jordan Lee", "Experience", "Operations Analyst, Acme Corp, 2019 - 2024", "Led weekly reporting across four teams and cut close time by two days.", "Built a customer portal serving 120000 customers.",
  "Managed 25 employees and 1200 shipments a month.", "Education", "BS Economics, State University, 2019", "Skills", "SQL, Excel, Tableau"];
async function ingest(lines: string[]) {
  const bytes = docxOf(lines), stored: unknown[] = [];
  const res = await ingestResumeFile({ userId: "TEST-r8g", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name: "resume.docx", mime: DOCX, size: bytes.length },
    fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
  return { res: res as { ok: boolean; why?: string; reply?: string; lines?: number[] }, stored };
}

Deno.test("R8G-1 every reviewer hand-over refuses the upload through the DOCX path, stores nothing and is never echoed", async () => {
  for (const [source, cases] of Object.entries(corpus.handover)) {
    for (const c of cases) {
      const { res, stored } = await ingest([...BODY.slice(0, 4), ...c.split("\n"), ...BODY.slice(4)]);
      const tag = `${source}: ${JSON.stringify(c)}`;
      assertNode.equal(res.ok, false, tag);
      assertNode.equal(res.why, "secret", tag);
      assertNode.equal(stored.length, 0, tag);
      const reply = res.reply ?? "";
      for (const l of c.split("\n").map((s) => s.trim()).filter((s) => s.length >= 4)) assertNode.ok(!reply.includes(l), `${tag} reply repeats the line`);
      for (const core of c.match(/[\p{L}\p{N}]{4,}/gu) ?? []) if (/\d/.test(core)) assertNode.ok(!reply.includes(core), `${tag} reply repeats ${core}`);
    }
  }
});

// Two lines that trunk's own identity redactor (identity_redact.ts, unchanged in its code-word rule) already refuses; the file
// gate keeps them. They are refused on trunk too, so they are not a regression of this release.
const TRUNK_IDENTITY_REFUSES = ["Reconciled 300 GL accounts; GL code 4010-200 for revenue", "Published 'Token Binding at Scale' at USENIX Security 2020"];
Deno.test("R8G-2 the 351 realistic resume lines are kept and the file is stored once (trunk's identity refusals listed)", async () => {
  const refused: string[] = [];
  for (const l of corpus.harmless) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), l, ...BODY.slice(4)]);
    if (!res.ok || stored.length !== 1) refused.push(l);
  }
  assertNode.deepEqual(refused, TRUNK_IDENTITY_REFUSES);
  const text = (l: string) => [...BODY.slice(0, 4), l, ...BODY.slice(4)].join("\n");
  for (const l of TRUNK_IDENTITY_REFUSES) {
    assertNode.deepEqual(fileCodeLines(text(l)), [], l); // not the file gate
    assertNode.ok(redactIdentity(text(l)).removed.length > 0, l); // the identity redactor, as on trunk
  }
});

// Review of a7b76b6f: the check's text normalisation never moves a line. A carriage return next to a soft hyphen, zero-width or
// combining character stays its own line break, so the reply names the line the person sees.
Deno.test("R8G-3 normalisation keeps line numbers: CR beside an invisible character, CRLF, lone CR", () => {
  assertNode.deepEqual(fileCodeLines("a\r­\nb\nCode: 482913"), [4]);
  assertNode.deepEqual(fileCodeLines("a\r\nb\r\nCode: 482913"), [3]);
  assertNode.deepEqual(fileCodeLines("a\rb\rCode: 482913"), [3]);
  assertNode.deepEqual(fileCodeLines("a​\r\nb́\nCode: 482913"), [3]);
});

// Review of 3896c31c. Hand-overs in the languages it showed refuse; its realistic lines stay; a long line is judged in linear
// time; a code in a Word header, footer or tracked deletion (parts the reader does not show) refuses the file, nothing kept.
import { zipOf } from "./scenarios/onboarding-r2-generator.ts";
Deno.test("R8G-4 review of 3896c31c: inflected and compound labels, capital Greek, safe shapes, linear time, hidden Word parts", async () => {
  for (const c of ["Je inlogcode is 482913", "Inloggningskod: 482913", "Din verifieringskod är 482913", "Ihr Anmeldecode lautet: 482913", "Dein Verifizierungscode: 482913",
    "Din bekræftelseskode er 482913", "Engangskoden din er 482913", "Onay kodunuz: 482913", "Giriş kodunuz 482913", "Kodu: 482913", "Vahvistuskoodisi on 482913",
    "Kertakäyttöinen koodi: 482913", "Codul tău de verificare este 482913", "Cod de verificare: 482913", "Az ellenőrző kódod: 482913", "Mã của bạn: 482913",
    "Mã đăng nhập: 482913", "你的登录码是 482913", "动态口令：482913", "ログインコード: 482913",
    "Κωδικός επαλήθευσης: 482913", "Κωδικός: 482913", "κωδικός: 482913",
    "Kodi yako ya uthibitisho ni 482913", "Nambari ya siri: 482913"]) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), c, ...BODY.slice(4)]);
    assertNode.ok(!res.ok && stored.length === 0, JSON.stringify(c));
  }
  for (const l of ["Implemented TOTP (RFC 6238) for an internal SSO tool.", "Verification testing of 28nm ASIC blocks using UVM.", "Nurse, NHS Band 6, NMC PIN 12A3456E",
    "A320neo type rating, 2,400 hours", "验证系统负责人，覆盖 3000 万用户。"]) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), l, ...BODY.slice(4)]);
    assertNode.ok(res.ok && stored.length === 1, JSON.stringify(l));
  }
  const t0 = performance.now();
  assertNode.deepEqual(fileCodeLines("Wrote code to use the key API and enter data; ".repeat(22000)), []);
  assertNode.deepEqual(fileCodeLines("Wrote code to use the key API and enter data; ".repeat(22000) + " Verification code: 482913"), [1]);
  assertNode.ok(performance.now() - t0 < 15000, `two 1 MB lines took ${Math.round(performance.now() - t0)} ms`);
  const enc = new TextEncoder(), W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = BODY.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
  const docx = (extra: { name: string; xml: string }[], deleted = "") => zipOf([
    { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}${deleted}<w:sectPr/></w:body></w:document>`) },
    ...extra.map((e) => ({ name: e.name, data: enc.encode(e.xml) }))]);
  const upload = async (bytes: Uint8Array) => {
    const stored: unknown[] = [];
    const res = await ingestResumeFile({ userId: "TEST-r8g", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name: "resume.docx", mime: DOCX, size: bytes.length },
      fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
    return { res: res as { ok: boolean; reply?: string }, stored };
  };
  const header = await upload(docx([{ name: "word/header1.xml", xml: `<w:hdr ${W}><w:p><w:r><w:t>Verification code: 482913</w:t></w:r></w:p></w:hdr>` }]));
  assertNode.ok(!header.res.ok && header.stored.length === 0 && !String(header.res.reply).includes("482913"), "header");
  const tracked = await upload(docx([], `<w:p><w:del><w:r><w:delText>My code is 482913</w:delText></w:r></w:del></w:p>`));
  assertNode.ok(!tracked.res.ok && tracked.stored.length === 0, "tracked deletion");
  const plainHeader = await upload(docx([{ name: "word/footer1.xml", xml: `<w:ftr ${W}><w:p><w:r><w:t>Jordan Lee · Page 1 · 2024</w:t></w:r></w:p></w:ftr>` }]));
  assertNode.ok(plainHeader.res.ok && plainHeader.stored.length === 1, "a plain footer is kept");
});

// Review of 1c937596. The hidden-part pass fails closed (a part it cannot read refuses the file), keeps breaks and tabs, and reads
// every XML part; long lines are judged by sentences so a value keeps its label; long-tail languages; three postal look-alikes.
Deno.test("R8G-5 review of 1c937596: hidden parts fail closed, breaks kept, all parts read, sentence windows, long-tail labels", async () => {
  const enc = new TextEncoder(), W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = BODY.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
  const types = { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') };
  const docx = (extra: { name: string; xml: string }[], inBody = "") => zipOf([types,
    { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}${inBody}<w:sectPr/></w:body></w:document>`) },
    ...extra.map((e) => ({ name: e.name, data: enc.encode(e.xml) }))]);
  const upload = async (bytes: Uint8Array) => {
    const stored: unknown[] = [];
    const res = await ingestResumeFile({ userId: "TEST-r8g", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name: "resume.docx", mime: DOCX, size: bytes.length },
      fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
    return { res: res as { ok: boolean; reply?: string }, stored };
  };
  const refused = async (bytes: Uint8Array, tag: string) => { const u = await upload(bytes); assertNode.ok(!u.res.ok && u.stored.length === 0 && !String(u.res.reply).includes("482913"), tag); };
  const hdr = (inner: string) => `<w:hdr ${W}><w:p>${inner}</w:p></w:hdr>`;
  await refused(docx([{ name: "word/header1.xml", xml: hdr("<w:r><w:t>Jordan Lee</w:t><w:br/><w:t>482913</w:t></w:r>") }]), "break in a header");
  await refused(docx([{ name: "word/header1.xml", xml: hdr("<w:r><w:t>jordan.lee@example.com</w:t><w:br/><w:t>OTP 482913</w:t></w:r>") }]), "break then OTP");
  await refused(docx([{ name: "word/Header1.xml", xml: hdr("<w:r><w:t>Verification code: 482913</w:t></w:r>") }]), "odd header name");
  await refused(docx([{ name: "word/glossary/document.xml", xml: `<w:glossaryDocument ${W}><w:p><w:r><w:t>Login code 482913</w:t></w:r></w:p></w:glossaryDocument>` }]), "glossary");
  await refused(docx([{ name: "docProps/core.xml", xml: '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:description>My verification code is 482913</dc:description></cp:coreProperties>' }]), "document properties");
  await refused(docx([], '<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://login.example.com/?code=482913" </w:instrText></w:r></w:p>'), "field instruction");
  await refused(docx([], `<w:p><w:r><w:drawing><wp:docPr xmlns:wp="z" id="1" name="Picture 1" descr="Verification code 482913"/></w:drawing></w:r></w:p>`), "alt text");
  // A part the reader cannot read (bad checksum, or past its size cap) refuses the file: it may hold anything.
  const good = docx([{ name: "word/header1.xml", xml: hdr("<w:r><w:t>Verification code: 482913</w:t></w:r>") }]);
  const bad = good.slice(), name = enc.encode("word/header1.xml");
  const at = (() => { for (let k = bad.length - name.length; k >= 0; k--) if (name.every((b, j) => bad[k + j] === b)) return k; return -1; })();
  bad[at - 46 + 16] ^= 0xff; // the central directory's checksum of the header part
  await refused(bad, "unreadable header");
  await refused(docx([{ name: "word/header1.xml", xml: hdr(`<w:r><w:t>Your verification code is 482913${" ".repeat(5_400_000)}</w:t></w:r>`) }]), "header past the size cap");
  const footer = await upload(docx([{ name: "word/footer1.xml", xml: `<w:ftr ${W}><w:p><w:r><w:t>Jordan Lee</w:t><w:br/><w:t>Page 1 of 2</w:t></w:r></w:p></w:ftr>` }]));
  assertNode.ok(footer.res.ok && footer.stored.length === 1, "a plain footer with a break is kept");
  // Long lines: a value keeps its label wherever the sentence falls.
  const filler = "Partnered with the login team on onboarding flows and reporting across regions. ";
  for (let k = 0; k < 700; k += 23) {
    for (const tail of ["Army Infantry Squad Leader, 2008 - 2014, Secret clearance.", "Employee ID 004512 (available on request)."]) assertNode.deepEqual(fileCodeLines(filler.repeat(9).slice(0, k + 600) + " " + tail), [], `${tail} at ${k}`);
    assertNode.deepEqual(fileCodeLines(filler.repeat(20).slice(0, k + 600) + " Verification code: 482913. " + filler), [1], `code at ${k}`);
  }
  for (const c of ["Din bekreftelseskode er 482913", "Hasło: 482913", "Twoje hasło jednorazowe to 482913", "Mã: 482913", "Mật khẩu một lần: 482913", "A kódod: 482913",
    "Számkód 482913", "El teu codi de verificació és 482913", "Jou verifikasiekode is 482913", "Vaša koda za preverjanje je 482913", "Jūsų patvirtinimo kodas: 482913",
    "Jūsu verifikācijas kods ir 482913", "Sinu kinnituskood on 482913", "আপনার ওটিপি 482913", "آپ کا کوڈ 482913 ہے",
    "Nambari yako ya uthibitisho ni 482913", "Staðfestingarkóði: 482913", "Zure kodea: 482913", "Eich cod dilysu yw 482913", "Ikhodi yakho ithi 482913"]) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), c, ...BODY.slice(4)]);
    assertNode.ok(!res.ok && stored.length === 0, JSON.stringify(c));
  }
  // An Indian postal PIN code: the file gate keeps it; trunk's identity redactor refuses it, as on trunk.
  const pin = [...BODY.slice(0, 4), "Software Engineer, Infosys, Bengaluru; PIN code 560100", ...BODY.slice(4)].join("\n");
  assertNode.deepEqual(fileCodeLines(pin), []); assertNode.ok(redactIdentity(pin).removed.length > 0);
  for (const l of ["Kode pos 12190, Jakarta Selatan", "Led migration of 2FA codes from SMS to authenticator apps.",
    "Built barcode scanning for 4500 SKUs", "Kodak Alaris, Rochester NY, 2016 - 2019", "Decoded 2500 support tickets"]) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), l, ...BODY.slice(4)]);
    assertNode.ok(res.ok && stored.length === 1, JSON.stringify(l));
  }
});

// Review of 135237e5. Real Word files (python-docx, pandoc, LibreOffice) are kept: their styles, settings, fonts, numbering,
// theme, app and core properties carry metadata (colours, rsids, panose, nsid, AppVersion, W3CDTF dates), not resume text. Text
// is read where Word keeps it; every listed part must still be readable. altChunk HTML, VML text boxes and an embedded Word file
// are read. A profile link's handle is not a value. A sign-in purpose overrides a named label. No-space runs stay linear.
Deno.test("R8G-6 review of 135237e5: real Word files kept, text-bearing parts only, altChunk/VML/embedded read, links, linear", async () => {
  const dir = new URL("./fixtures/r8-real-docx/", import.meta.url);
  const upload = async (bytes: Uint8Array, name = "resume.docx") => {
    const stored: unknown[] = [];
    const res = await ingestResumeFile({ userId: "TEST-r8g", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name, mime: DOCX, size: bytes.length },
      fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
    return { res: res as { ok: boolean; reply?: string }, stored };
  };
  for (const f of ["pydocx-plain.docx", "pandoc-plain.docx", "libreoffice-pydocx.docx", "libreoffice-pandoc.docx"]) {
    const u = await upload(Deno.readFileSync(new URL(f, dir)), f);
    assertNode.ok(u.res.ok && u.stored.length === 1, `${f}: ${JSON.stringify(u.res).slice(0, 200)}`);
  }
  for (const f of ["pydocx-header-code.docx", "pydocx-comment-code.docx"]) {
    const u = await upload(Deno.readFileSync(new URL(f, dir)), f);
    assertNode.ok(!u.res.ok && u.stored.length === 0 && !String(u.res.reply).includes("482913"), f);
  }
  const enc = new TextEncoder(), W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = BODY.map((t) => `<w:p><w:r><w:rPr><w:color w:val="2E74B5"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
  const types = { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') };
  const docx = (extra: { name: string; data: Uint8Array | string }[], inBody = "") => zipOf([types,
    { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}${inBody}<w:sectPr/></w:body></w:document>`) },
    ...extra.map((e) => ({ name: e.name, data: typeof e.data === "string" ? enc.encode(e.data) : e.data }))]);
  // The metadata the review found refusing every real file.
  const metadata = [
    { name: "word/styles.xml", data: `<w:styles ${W}><w:style w:styleId="Heading1"><w:rPr><w:color w:val="365F91"/></w:rPr><w:rsid w:val="00FC693F"/></w:style></w:styles>` },
    { name: "word/settings.xml", data: `<w:settings ${W}><w:rsids><w:rsidRoot w:val="00904D0C"/><w:rsid w:val="00FC693F"/></w:rsids></w:settings>` },
    { name: "word/fontTable.xml", data: `<w:fonts ${W}><w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:sig w:usb0="E0002AFF" w:usb1="C000247B"/></w:font></w:fonts>` },
    { name: "word/numbering.xml", data: `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:nsid w:val="FFFFFF88"/><w:tmpl w:val="D0A62B40"/></w:abstractNum></w:numbering>` },
    { name: "docProps/app.xml", data: '<Properties xmlns="x"><Template>Normal.dotm</Template><TotalTime>12</TotalTime><Pages>1</Pages><Words>310</Words><AppVersion>16.0000</AppVersion></Properties>' },
    { name: "docProps/core.xml", data: '<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:title>Jordan Lee Resume</dc:title><cp:revision>14</cp:revision><dcterms:created>2026-11-07T16:25:11Z</dcterms:created></cp:coreProperties>' },
    { name: "word/_rels/document.xml.rels", data: '<Relationships xmlns="r"><Relationship Id="rId9" Type="hyperlink" Target="https://www.linkedin.com/in/wei-zhang-4b7a19120/" TargetMode="External"/></Relationships>' },
    { name: "customXml/item1.xml", data: '<b:Sources xmlns:b="s" SelectedStyle="\\APA.XSL" StyleName="APA" Version="6"/>' },
    { name: "word/theme/theme1.xml", data: '<a:theme xmlns:a="a" name="Office Theme"><a:srgbClr val="4F81BD"/></a:theme>' }];
  const meta = await upload(docx(metadata));
  assertNode.ok(meta.res.ok && meta.stored.length === 1, `metadata: ${JSON.stringify(meta.res).slice(0, 200)}`);
  const refused = async (bytes: Uint8Array, tag: string) => { const u = await upload(bytes); assertNode.ok(!u.res.ok && u.stored.length === 0 && !String(u.res.reply).includes("482913"), tag); };
  await refused(docx([...metadata, { name: "word/afchunk.htm", data: "<html><body><p>Jordan Lee</p><p>My verification code is 482913</p></body></html>" }]), "altChunk HTML");
  await refused(docx([...metadata, { name: "word/vmlDrawing1.vml", data: '<xml><v:shape><v:textbox><div><p>Login code: 482913</p></div></v:textbox></v:shape></xml>' }]), "VML text box");
  await refused(docx([...metadata, { name: "word/embeddings/Microsoft_Word_Document.docx", data: docx([{ name: "word/header1.xml", data: `<w:hdr ${W}><w:p><w:r><w:t>OTP 482913</w:t></w:r></w:p></w:hdr>` }]) }]), "embedded Word file");
  await refused(docx([...metadata, { name: "word/_rels/header1.xml.rels", data: '<Relationships xmlns="r"><Relationship Id="rId1" Target="https://login.example.com/verify?code=482913" TargetMode="External"/></Relationships>' }]), "a link's query");
  const kept = await upload(docx([...metadata, { name: "word/afchunk.htm", data: "<html><body><p>Volunteer, Food Bank, 2018 - 2020</p></body></html>" }]));
  assertNode.ok(kept.res.ok && kept.stored.length === 1, "a plain altChunk is kept");
  // Lines.
  for (const l of ["linkedin.com/in/mariagonzalez123", "linkedin.com/in/priya-raghavan-8a1b2c3d", "+48 501 234 567 | linkedin.com/in/annakowalska", "github.com/jordanlee-42 | gitlab.com/jl42"]) {
    const { res, stored } = await ingest([...BODY.slice(0, 4), l, ...BODY.slice(4)]);
    assertNode.ok(res.ok && stored.length === 1, JSON.stringify(l));
  }
  const ref = await ingest([...BODY.slice(0, 4), "Ref: 482913 use this to sign in", ...BODY.slice(4)]);
  assertNode.ok(!ref.res.ok && ref.stored.length === 0, "a sign-in purpose after a named label");
  const t0 = performance.now();
  assertNode.deepEqual(fileCodeLines("x\n" + "x".repeat(200000)), []);
  assertNode.deepEqual(fileCodeLines("负责数据平台建设，覆盖全国用户。".repeat(3000)), []);
  assertNode.deepEqual(fileCodeLines("x".repeat(150000) + " Verification code: 482913 " + "y".repeat(5000)), [1]);
  // Re-check of 632ca084: a piece keeps at least 64 characters of the text before it, so a value is not cut from its label.
  assertNode.deepEqual(fileCodeLines("z".repeat(425) + " Login code - 4829130217 " + "q".repeat(1500)), [1]);
  assertNode.deepEqual(fileCodeLines("z".repeat(431) + " 2FA code = K7X9P2 unlocks my account " + "q".repeat(1500)), [1]);
  const hand = Object.values(corpus.handover).flat().filter((c) => !c.includes("\n") && fileCodeLines(c).length);
  for (const c of hand) for (let k = 360; k <= 460; k += 10) assertNode.ok(fileCodeLines("z".repeat(k) + " " + c + " " + "q".repeat(1500)).length, `${k}: ${c}`);
  assertNode.ok(performance.now() - t0 < 5000, `no-space runs took ${Math.round(performance.now() - t0)} ms`);
});
