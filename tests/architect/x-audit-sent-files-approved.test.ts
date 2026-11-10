// x-audit (2026-11-10): every file that leaves in a submit request is a file the person approved. carriesApproved
// (scripts/career/request-verifier.ts) checked that the approved resume is in the body, but a second file in the same
// request (a cover letter or any upload the person never saw, attached by the employer's script) went out with it.
// Page-owned strings (hidden fields, tokens) are not in scope here: they change on every load and are a ruling.
// Run: deno test -A --no-check tests/architect/x-audit-sent-files-approved.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { bodyContents, carriesApproved } from "../../scripts/career/request-verifier.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const RESUME = bytes("%PDF-1.4\n% approved resume\n");
const OTHER = bytes("%PDF-1.4\n% a cover letter nobody approved\n");

async function verdict(parts: [string, string | Blob][]): Promise<string> {
  const form = new FormData();
  for (const [k, v] of parts) v instanceof Blob ? form.append(k, v, k === "resume" ? "resume.pdf" : "other.pdf") : form.append(k, v);
  const wire = { email: "synthetic@example.test", resume: { filename: "resume.pdf", sha256: await sha(RESUME) } };
  try {
    carriesApproved(await bodyContents("multipart/form-data", new Uint8Array(), form), wire);
    return "ok";
  } catch (e) {
    return `stopped:${(e as Error).message}`;
  }
}

Deno.test("the approved resume and the approved answers go out: ok", async () => {
  assertEquals(await verdict([["email", "synthetic@example.test"], ["resume", new Blob([RESUME])]]), "ok");
});

Deno.test("an extra file nobody approved in the same request: stopped, nothing sent", async () => {
  assertEquals(await verdict([["email", "synthetic@example.test"], ["resume", new Blob([RESUME])], ["cover_letter", new Blob([OTHER])]]), "stopped:unapproved_file");
});

Deno.test("an empty optional file input (no file chosen) is not a file sent: ok", async () => {
  assertEquals(await verdict([["email", "synthetic@example.test"], ["resume", new Blob([RESUME])], ["cover_letter", new Blob([])]]), "ok");
});

Deno.test("a long token-looking hidden string is not mistaken for an unapproved file: ok", async () => {
  assertEquals(await verdict([["email", "synthetic@example.test"], ["authenticity_token", "QWxhZGRpbjpvcGVuIHNlc2FtZQ0KQWxhZGRpbjpvcGVuIHNlc2FtZQ=="], ["resume", new Blob([RESUME])]]), "ok");
});
