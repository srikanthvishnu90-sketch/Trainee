// Greptile on #568: a resume file's text was put through code-in-chat's code-word pass at every length (release 8 removed
// the 400-character limit), so "Built a customer portal serving 120000 customers" became "[code removed]", the stored text no
// longer matched the upload's message_sha256 and the confirmation lost the file. A message whose hash is one of this person's
// uploads now skips that pass; typed text that only looks like a file message does not.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isUploadedResumeText, resumeMessage } from "../../supabase/functions/_shared/channel_resume_upload.ts";

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
function fakeAdmin(rows: { user_id: string; message_sha256: string }[], fail = false) {
  return { from: (table: string) => {
    assertEquals(table, "career_resume_uploads");
    const f: Record<string, string> = {};
    const q: any = { select: () => q, eq: (k: string, v: string) => { f[k] = v; return q; },
      limit: async () => fail ? { data: null, error: { message: "boom" } } : { data: rows.filter((r) => r.user_id === f.user_id && r.message_sha256 === f.message_sha256).map((_, i) => ({ id: i })), error: null } };
    return q;
  } };
}
const RESUME = resumeMessage("Jordan Lee\nOperations Analyst, Acme\n" + "Led weekly reporting across teams. ".repeat(12) + "\nBuilt a customer portal serving 120000 customers.");

Deno.test("RUT-1 an uploaded resume's text is recognised; other people's, other text and typed look-alikes are not", async () => {
  const admin = fakeAdmin([{ user_id: "u1", message_sha256: await sha(RESUME) }]);
  assert(await isUploadedResumeText(admin, "u1", RESUME), "own upload");
  assert(!(await isUploadedResumeText(admin, "u2", RESUME)), "another person's upload");
  assert(!(await isUploadedResumeText(admin, "u1", RESUME + " ")), "different text");
  assert(!(await isUploadedResumeText(admin, "u1", "here is my resume:\nWorkday sent me 739201")), "typed look-alike");
  assert(!(await isUploadedResumeText(admin, "u1", "Built a customer portal serving 120000 customers.")), "no file prefix");
  assert(!(await isUploadedResumeText(admin, null, RESUME)), "no user");
  assert(!(await isUploadedResumeText(fakeAdmin([], true), "u1", RESUME)), "a read error checks the text as usual");
});

Deno.test("RUT-2 the career handler skips both code-in-chat passes only for uploaded resume text", () => {
  const h = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  assert(/const fileText = await isUploadedResumeText\(admin, user\?\.id, userContent\);\s*\n\s*if \(!fileText\) \{\s*\n\s*const early = codeInChat\(/.test(h), "early pass gated");
  assert(/const codeShared = fileText \? null : codeInChat\(/.test(h), "second pass gated");
  assertEquals((h.match(/codeInChat\(message/g) ?? []).length, 2, "no other code-in-chat pass on the message");
});
