// OWNER RULE (2026-10-26, "never submit applications without a real resume") on the emailed application (review of #194,
// 2026-10-27): emailTurn reads the same fail-closed resume check as the chat's apply turn and the card
// (resumeOnFileReader -> career_resume_on_file). No confirmed resume on file: no email drafted and, at the yes, nothing
// reserved or sent. Unreadable: the same, said plainly. The database refuses the reserve on its own too
// (tests/db/career_resume_required.test.sql 2b).
// Run: deno test -A --no-check tests/architect/email-apply-resume-rule.test.ts
import { EMAIL_INTENT, type EmailCard, type EmailPosting, type EmailStore, emailTurn } from "../../supabase/functions/_shared/career_apply_email.ts";
import { resumeOnFileReader } from "../../supabase/functions/_shared/career_apply_from_chat.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.parse("2026-10-27T15:00:00Z");
const POSTING: EmailPosting = { job_id: "lever:acme:1", company: "Acme Retail", title: "Data Analyst", url: "https://acme.example/jobs/1", description: "Email your resume to jobs@acme.example.", apply_email: "jobs@acme.example" };
const FACTS = [
  { id: "F-001", kind: "experience", text: "Data analyst at Example Analytics, 2022 to 2024; built weekly sales dashboards in Tableau used by 40 store managers", needs_confirmation: false, status: "confirmed", confirmation_event_id: "ev-1" },
  { id: "F-002", kind: "project", text: "Built a Python demand forecast for Example Analytics that cut stockouts by 12%", needs_confirmation: false, status: "confirmed", confirmation_event_id: "ev-2" },
];
const BODY = "I am a data analyst at Example Analytics, where I built weekly sales dashboards in Tableau used by 40 store managers. I also built a Python demand forecast that cut stockouts by 12%.";
const BYTES = new TextEncoder().encode("%PDF-1.4 TEST resume");
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

// The person's resume on file, as each check could answer it: true, false, null (unknown), or a throw.
function world(onFile: () => Promise<boolean | null>) {
  let card: EmailCard | null = null, last: { intent: string | null; meta: Record<string, unknown> } | null = null;
  const reserves: string[] = [], sends: string[] = [], modelCalls: unknown[] = [], resumeReads: string[] = [];
  const store: EmailStore = {
    postings: async () => [POSTING],
    card: async () => (card ? JSON.parse(JSON.stringify(card)) : null),
    setCard: async (_u, c) => { card = JSON.parse(JSON.stringify(c)); },
    lastAssistant: async () => last,
    reserve: async (_u, _p, hash) => { reserves.push(hash); card = { ...card!, state: "sending" }; return { id: "E1", lease_token: "L" }; },
    finish: async () => {},
  };
  const say = async (message: string) => {
    const r = await emailTurn({ message, userId: "U1", threadId: "T1", now: NOW, deps: {
      store, profile: () => ({ facts: FACTS, basics: { name: "Test Person" } }),
      draft: { model: async (p: unknown) => { modelCalls.push(p); return { type: "message", role: "assistant", content: [{ type: "text", text: BODY }], stop_reason: "end_turn" } as any; }, facts: () => FACTS },
      resume: async (_u, p) => { resumeReads.push(p.job_id); return { filename: "resume.pdf", bytes: BYTES, sha256: await sha(BYTES), tailored: false }; },
      attachment: async (_u, s) => ({ filename: "resume.pdf", bytes: BYTES, sha256: s, tailored: false }),
      canSend: async () => true, sendOn: true,
      send: async (_u, m) => { sends.push(m.to); return { status: "sent", idHash: "7".repeat(64) }; },
      resumeOnFile: onFile,
    } });
    last = r ? (r.waiting ? { intent: EMAIL_INTENT, meta: { email_card: r.card_id } } : { intent: "career_apply_email_answer", meta: {} }) : { intent: "agent", meta: {} };
    return r;
  };
  return { say, reserves, sends, modelCalls, resumeReads, get card() { return card; } };
}

Deno.test("email apply, no confirmed resume on file: nothing drafted, no model call, nothing reserved or sent; said plainly", async () => {
  const w = world(async () => false);
  const r = await w.say("apply by email to Acme Retail");
  eq(r?.status, "no_resume", JSON.stringify(r));
  assert(/no confirmed resume on file/.test(r!.reply) && /Paste or attach your resume, confirm it, then ask again\./.test(r!.reply), r!.reply);
  eq([w.modelCalls.length, w.resumeReads.length, w.reserves.length, w.sends.length], [0, 0, 0, 0], "nothing drafted, read, reserved or sent");
  eq(w.card, null, "no card shown");
});

Deno.test("email apply, the resume check unreadable (null or a throw): unknown decides nothing; nothing drafted or sent", async () => {
  for (const onFile of [async () => null, async () => { throw new Error("TEST: down"); }]) {
    const w = world(onFile as () => Promise<boolean | null>);
    const r = await w.say("apply by email to Acme Retail");
    eq(r?.status, "resume_unreadable", JSON.stringify(r));
    assert(/couldn't check your resume on file/.test(r!.reply), r!.reply);
    eq([w.modelCalls.length, w.reserves.length, w.sends.length], [0, 0, 0]);
  }
});

Deno.test("email apply: a resume deleted after the card was shown: the yes reserves and sends nothing", async () => {
  let onFile: boolean | null = true;
  const w = world(async () => onFile);
  const shown = await w.say("apply by email to Acme Retail");
  eq(shown?.status, "shown", JSON.stringify(shown));
  onFile = false;
  const yes = await w.say("yes");
  eq(yes?.status, "no_resume", JSON.stringify(yes));
  assert(/Not sent: I have no confirmed resume on file for you/.test(yes!.reply) && /Nothing went to Acme Retail\./.test(yes!.reply), yes!.reply);
  eq([w.reserves.length, w.sends.length], [0, 0], "nothing reserved, nothing sent");
});

Deno.test("email apply: the check unreadable at the yes keeps the card for a later yes; nothing reserved or sent", async () => {
  let onFile: boolean | null = true;
  const w = world(async () => onFile);
  await w.say("apply by email to Acme Retail");
  onFile = null;
  const yes = await w.say("yes");
  eq([yes?.status, yes?.waiting], ["resume_unreadable", true], JSON.stringify(yes));
  eq([w.reserves.length, w.sends.length], [0, 0]);
  onFile = true;
  const again = await w.say("yes");
  eq(again?.status, "sent", JSON.stringify(again));
  eq([w.reserves.length, w.sends.length], [1, 1], "once readable, the yes sends exactly the card, once");
});

Deno.test("email apply: a confirmed resume on file drafts and sends as before", async () => {
  const w = world(async () => true);
  eq((await w.say("apply by email to Acme Retail"))?.status, "shown");
  eq((await w.say("yes"))?.status, "sent");
  eq(w.sends, ["jobs@acme.example"]);
});

Deno.test("the chat wires the email turn to the same fail-closed reader as the apply turn and the card", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const at = src.indexOf("await emailTurn(");
  assert(at > 0, "the handler calls emailTurn");
  const call = src.slice(at, src.indexOf("} })", at));
  assert(/resumeOnFile: resumeOnFileReader\(admin, user\.id\)/.test(call), "emailTurn gets resumeOnFileReader(admin, user.id)");
  // and that reader answers only from career_resume_on_file, fail closed
  const calls: string[] = [];
  eq(await resumeOnFileReader({ rpc: async (n: string) => { calls.push(n); return { data: null, error: { message: "x" } }; } }, "u")(), null);
  eq(calls, ["career_resume_on_file"]);
});
