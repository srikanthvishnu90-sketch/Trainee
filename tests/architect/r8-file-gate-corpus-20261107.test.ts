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
