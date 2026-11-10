// Final bounded review of 64c7f13b: a code in an attribute or element name is never stored; hex colours and page-number fields
// survive the clean copy; a Word horizontal line refuses rather than vanish.
import assertNode from "node:assert/strict";
import { ingestResumeFile } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { DOCX, zipOf } from "./scenarios/onboarding-r2-generator.ts";
import * as zlib from "node:zlib";
import * as nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
// deno-lint-ignore no-explicit-any
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
const enc = new TextEncoder(), W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';
const BODY = ["Jordan Lee", "Experience", "Operations Analyst, Acme Corp, 2019 - 2024", "Led weekly reporting across four teams and cut close time by two days.", "Built a customer portal serving 120000 customers.", "Education", "B.S. Business, State University, 2018"].map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
const types = { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') };
const rels = { name: "_rels/.rels", data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') };
const docx = (inBody: string) => zipOf([types, rels, { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${BODY}${inBody}<w:sectPr/></w:body></w:document>`) }]);
const upload = async (bytes: Uint8Array) => {
  const stored: any[] = [];
  const res: any = await ingestResumeFile({ userId: "TEST-r8c", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name: "resume.docx", mime: DOCX, size: bytes.length },
    fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
  return { res, stored };
};
const storedXml = (row: any) => { const buf = Buffer.from(Uint8Array.from(atob(row.content_b64), (c) => c.charCodeAt(0))); return (R.docxPartNames(buf) as string[]).map((n) => new TextDecoder().decode(new Uint8Array(R.docxPart(buf, n)))).join("\n"); };
const noCode = async (inBody: string, tag: string) => {
  const u = await upload(docx(inBody));
  assertNode.ok(!String(u.res.reply ?? "").includes("482913"), `${tag}: not echoed`);
  if (u.stored.length) {
    // the clean zip is stored (no compression in the clean writer): its bytes hold no code
    assertNode.ok(!storedXml(u.stored[0]).includes("482913"), `${tag}: the clean copy holds no code`);
  }
};
Deno.test("R8C-1 a code in an attribute or element name never reaches the clean copy", async () => {
  await noCode(`<w:p><w:r><w:rPr><w:sz w:code="482913" w:val="22"/></w:rPr><w:t>Skills</w:t></w:r></w:p>`, "w:code attribute");
  await noCode(`<w:p><w:r><w:rPr><w:b w:otp482913="1"/></w:rPr><w:t>Skills</w:t></w:r></w:p>`, "a code in an attribute name");
  await noCode(`<w:p><w:r><w:rPr><w:code482913/></w:rPr><w:t>Skills</w:t></w:r></w:p>`, "a code in an element name");
});
Deno.test("R8C-2 hex colours and page-number fields are kept", async () => {
  const u = await upload(docx(`<w:p><w:r><w:rPr><w:color w:val="C00000"/></w:rPr><w:t>Red heading</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`));
  assertNode.ok(u.res.ok && u.stored.length === 1, String(u.res.reply ?? ""));
  const x = storedXml(u.stored[0]);
  assertNode.ok(/w:color w:val="C00000"/.test(x), "the colour is kept");
  assertNode.ok(/fldCharType="begin"/.test(x) && /<w:instrText[^>]*> PAGE <\/w:instrText>/.test(x), "the page field is kept");
});
Deno.test("R8C-3 a field instruction that is not a known field keeps only its result; a horizontal line refuses", async () => {
  await noCode(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> COMMENTS 482913 </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`, "an unknown field instruction");
  const h = await upload(docx(`<w:p><w:r><w:pict><v:rect style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t" fillcolor="#a0a0a0" stroked="f"/></w:pict></w:r></w:p>`));
  assertNode.ok(!h.res.ok && h.stored.length === 0, "a horizontal line is refused, not dropped");
});
