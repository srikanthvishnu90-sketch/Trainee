// Greptile on #567: chat_input normalises line endings, no-break/thin spaces, tabs and en/em dashes between digits. A
// resume file's message (channel_resume_upload.ts resumeMessage) is hashed at upload and matched to the stored chat text at
// confirm (fileUploadFor, message_sha256). Both must see the same normalisation, or a resume with "2022–2024" or a no-break
// space is confirmed as pasted text and loses its file.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { resumeMessage, resumeMessageCut } from "../../supabase/functions/_shared/channel_resume_upload.ts";

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const RESUME = (sep: string) => [
  "Jordan Lee", "Warehouse Associate, Acme Logistics", `2022${sep === "dash" ? "–" : "-"}2024`,
  `Picked and packed${sep === "nbsp" ? " " : " "}orders; forklift certified`, sep === "tab" ? "\tSkills:\tinventory,\tshipping" : "Skills: inventory, shipping",
  "Education: Lincoln High School, 2019",
].join(sep === "crlf" ? "\r\n" : "\n");

Deno.test("RMH-1 a resume file's message hash equals the hash of the text chat stores, for every normalised character", async () => {
  for (const sep of ["plain", "dash", "nbsp", "tab", "crlf"]) {
    const msg = resumeMessage(RESUME(sep));
    const i = chatInput(msg, [], 4000, {}) as { ok: boolean; userContent: string };
    assert(i.ok, sep);
    assertEquals(i.userContent, msg, `${sep}: chat stores the file message unchanged`);
    assertEquals(await sha(i.userContent), await sha(msg), sep);
  }
});

Deno.test("RMH-2 the cut check measures the normalised text", () => {
  const long = "x".repeat(3970) + "\r\n".repeat(20);
  assertEquals(resumeMessageCut(long), "here is my resume:\n".length + long.replace(/\r\n/g, "\n").trim().length > 4000);
});
