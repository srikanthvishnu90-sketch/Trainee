// Coordinator review of #360 (2026-10-31), items 1 and 2:
//   Q  missing questions are asked ONE per message, on every channel (the chat reply, the hosted push and the scheduled
//      push all compose with questionsText); the next is asked right after the answer; the card is prepared again only
//      once none is left open (prepareAfterAnswers).
//   C  a consent or yes/no question on the card reads "<the question>: <the choice sent>", never an option read as the
//      question ("You agree: Yes - I consent ...: No - I do not consent ..."). Proven on the page: discovery and binding
//      (bindFields), the label the payload, the card and the server's card check all use.
import assertNode from "node:assert/strict";
import { type OpenQuestion, PER_TEXT, type QuestionStore, questionsText, questionsTurn, type Shown, supabaseQuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { prepareAfterAnswers } from "../../supabase/functions/_shared/career_hosted_prepare.ts";
import { handlePrepareBridge, prepareToken } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { bindFields } from "../../scripts/career/form-bind.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const U = "00000000-0000-4000-8000-0000000003a1", T = "00000000-0000-4000-8000-0000000003a2";

const q = (n: number, label: string, extra: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`, key: `job:${String(n).repeat(16).slice(0, 16)}`, kind: "unknown", label,
  type: "input_text", options: [], company: "Ramp", job_ids: ["ashby:ramp:a13ae586-f4cb-4385-8822-c42b9b54ed74"], misfit: false, answer: null, ...extra,
});
const RAMP = [
  q(1, "School"),
  q(2, "What is your graduation date?"),
  q(3, "Requesting visa sponsorship?", { type: "checkbox", options: ["Yes", "No"] }),
];

function memoryStore(qs: OpenQuestion[]) {
  const rows = qs.map((x) => ({ ...x })), answered = new Map<string, string>();
  let shown: Shown | null = null, last: string | null = null;
  const store: QuestionStore = {
    open: async (_u, limit) => rows.filter((r) => !answered.has(r.id)).slice(0, limit),
    countOpen: async () => rows.filter((r) => !answered.has(r.id)).length,
    get: async (_u, ids) => rows.filter((r) => ids.includes(r.id)),
    answer: async (_u, id, a) => { answered.set(id, a); },
    shown: async () => shown,
    setShown: async (_u, s) => { shown = structuredClone(s); },
    lastAssistantIntent: async () => last,
  };
  return { store, answered, shownNow: () => shown, said: (intent: string | null) => { last = intent; } };
}

Deno.test("Q1 one question per message: the first open one, how many are open, never a numbered list", () => {
  eq(PER_TEXT, 1);
  const t = questionsText(RAMP, 3)!;
  eq(t.take.map((x) => x.label), ["School"]);
  assert(t.text.includes("School") && !t.text.includes("graduation") && !t.text.includes("sponsorship"), t.text);
  assert(/1 of 3/.test(t.text), `says how many: ${t.text}`);
  assert(!/Reply with each number|^\d+\. /m.test(t.text), `no numbered list: ${t.text}`);
  const one = questionsText([RAMP[0]], 1)!;
  assert(!/next one/.test(one.text) && /Just reply with your answer/.test(one.text), one.text);
});

Deno.test("Q2 chat: asked, answered, the next asked in the same reply, each answer saved to its own question; the card waits until none is open", async () => {
  const m = memoryStore(RAMP);
  const turn = async (message: string) => {
    const r = await questionsTurn({ message, userId: U, threadId: T, now: Date.now(), store: m.store, situation: undefined });
    // The handler keeps the questions this thread's last word while one is waiting (handler-career.ts).
    m.said(r && (["shown", "partial", "answered_next"].includes(r.status) || r.status.startsWith("draft")) ? "career_apply_questions" : "other");
    return r!;
  };
  const kicks: string[] = [];
  const admin = { rpc: async (name: string) => ({ data: name === "career_apply_questions_open_as" ? (await m.store.open(U, 1)) : null, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: [{ posting_key: "ashby:ramp:a13ae586" }], error: null }) }) }) }) }) }) };
  const env = { get: (k: string) => ({ CAREER_PREPARE_AHEAD_URL: "http://runner.test/prepare", CAREER_PREPARE_AHEAD_TOKEN: "TEST-token" } as Record<string, string>)[k] };
  const fetch = (async (u: string | URL | Request) => { kicks.push(String(u)); return new Response("{}", { status: 202 }); }) as typeof globalThis.fetch;

  const a = await turn("what do you need from me");
  eq(a.status, "shown");
  assert(a.reply.includes("School") && !a.reply.includes("graduation"), a.reply);
  eq(m.shownNow()!.ids, [RAMP[0].id], "only the one shown is what the next message answers");

  const later = await turn("not yet — I'll answer later");
  eq(m.answered.size, 0, `a deferral is never saved as the answer: ${later.reply}`);
  assert(!/Saved/.test(later.reply), later.reply);
  await turn("what do you need from me");
  const multi = await turn("1 DePaul University 2 06/13/2029 3 no");
  eq([multi.status, m.answered.size], ["partial", 0], `several numbered answers to one shown question save nothing: ${multi.reply}`);
  assert(/one question at a time/.test(multi.reply) && multi.reply.includes("School"), multi.reply);
  eq(m.shownNow()!.ids, [RAMP[0].id], "the same question still waits");
  const b = await turn("DePaul University");
  eq(b.status, "answered_next", b.reply);
  eq(m.answered.get(RAMP[0].id), "DePaul University");
  assert(/What is your graduation date\?/.test(b.reply) && !/sponsorship/.test(b.reply), `the next question, alone: ${b.reply}`);
  eq(m.shownNow()!.ids, [RAMP[1].id]);
  eq(await prepareAfterAnswers(b, { admin, userId: U, env, fetch }), "skipped", "no card while questions are open");
  eq(kicks.length, 0);

  const c = await turn("06/13/2029");
  eq(c.status, "answered_next", c.reply);
  eq(m.answered.get(RAMP[1].id), "06/13/2029", "the date went to the date question, not the school's");
  assert(/sponsorship/.test(c.reply), c.reply);
  eq(m.shownNow()!.ids, [RAMP[2].id]);

  const d = await turn("no");
  eq(d.status, "answered", d.reply);
  eq(m.answered.size, 3);
  eq(await m.store.countOpen(U), 0);
  eq(await prepareAfterAnswers(d, { admin, userId: U, env, fetch }), "started", "prepared again, for the card, only now");
  eq(kicks, ["http://runner.test/prepare"]);
});

Deno.test("Q4 'skip' moves on to the next question; the skipped one comes back after the others, and nothing is saved for it", async () => {
  const m = memoryStore(RAMP);
  const turn = async (message: string) => {
    const r = (await questionsTurn({ message, userId: U, threadId: T, now: Date.now(), store: m.store, situation: undefined }))!;
    m.said(["shown", "partial", "answered_next"].includes(r.status) ? "career_apply_questions" : "other");
    return r;
  };
  await turn("what do you need from me");
  const s = await turn("skip");
  eq(s.status, "answered_next", s.reply);
  assert(/graduation/.test(s.reply) && !/School/.test(s.reply.split("Next:")[1] ?? ""), s.reply);
  eq(m.answered.size, 0);
  const a = await turn("06/13/2029");
  assert(/sponsorship/.test(a.reply), `the next one not skipped: ${a.reply}`);
  const b = await turn("no");
  eq(b.status, "answered_next", "the skipped one is asked again");
  assert(/School/.test(b.reply), b.reply);
  const c = await turn("DePaul University");
  eq([c.status, m.answered.size], ["answered", 3]);
});

Deno.test("Q5 the production store keeps what was skipped, so 'skip' moves on there too", async () => {
  let kept: any = null;
  const q = { eq: () => q, maybeSingle: async () => ({ data: kept ? { value: kept } : null, error: null }), select: () => q };
  const admin = { from: () => ({ upsert: async (row: any) => { kept = JSON.parse(JSON.stringify(row.value)); return { error: null }; }, select: () => q }) };
  const store = supabaseQuestionStore(admin);
  await store.setShown(U, { thread: T, ids: [RAMP[1].id], at: new Date().toISOString(), skipped: [RAMP[0].id] });
  eq((await store.shown(U))?.skipped, [RAMP[0].id]);
});

Deno.test("Q3 the hosted push (Telegram, SMS, WhatsApp: one outbox text) carries exactly one question", async () => {
  const SECRET = "TEST-secret-0123456789abcdef0123456789abcdef", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000003a3", LEASE = "aaaaaaaa-bbbb-4ccc-8ddd-0000000003a4";
  const row = { id: RID, user_id: U, job_ids: ["ashby:ramp:1"], lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const calls: any[] = [];
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_request_ready") return [];
      if (name === "career_apply_prepare_request_questions") return RAMP;
      if (name === "career_apply_questions_push_requested_for") return true;
      if (name === "career_apply_prepare_request_finish") return { state: "done" };
      return null;
    } };
  await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"),
    outcomes: [{ job_id: "ashby:ramp:1", outcome: "asked", detail: "3" }] }, deps);
  const push = calls.find((c) => c.name === "career_apply_questions_push_requested_for");
  eq(push.args.p_ids, [RAMP[0].id], "one question pushed");
  assert(push.args.p_text.includes("School") && !push.args.p_text.includes("graduation"), push.args.p_text);
  assert(push.args.p_text.length <= 1600, "fits one SMS/WhatsApp message");
});

// ---------------------------------------------------------------------------------------- C: the card's consent lines

const opt = (name: string, value: string, label: string, groupLabel?: string) => ({ domIndex: 0, selector: `input[name="${name}"][value="${value}"]`,
  tag: "input", disabled: false, readOnly: false, inputType: "radio", name, id: "", label, optionValue: value, ...(groupLabel ? { groupLabel } : {}) });

Deno.test("C1 binding: a group the page gives no question is named by its choices, never by its first option", () => {
  const { schema } = bindFields([
    opt("whatsappConsent", "given", "Yes - I consent to receiving WhatsApp messages"),
    opt("whatsappConsent", "notGiven", "No - I do not consent to receiving WhatsApp messages"),
    opt("communicationConsent", "given", "Yes - I consent to receiving text messages", "Check Yes or No to indicate your agreement to receive text message updates from Ramp regarding your job application."),
    opt("communicationConsent", "notGiven", "No - I do not consent to receiving text messages", "Check Yes or No to indicate your agreement to receive text message updates from Ramp regarding your job application."),
  ]);
  eq(schema.map((s: any) => s.label), [
    "Yes - I consent to receiving WhatsApp messages / No - I do not consent to receiving WhatsApp messages",
    "Check Yes or No to indicate your agreement to receive text message updates from Ramp regarding your job application.",
  ]);
  for (const s of schema) assert(!s.options.some((o: any) => o.label === s.label), `the question is not one of its own options: ${s.label}`);
});

function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}

Deno.test({
  name: "C2 Ramp's form, discovered in a browser and prepared: every consent and yes/no line is '<question>: <the choice sent>'",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!browserEnv()) { if (Deno.env.get("CI") === "true") throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no browser"); return; }
    if (Deno.uid?.() === 0 && Deno.env.get("CI") !== "true") { console.log("NOT_RUN locally as root"); return; }
    const { ashbyLiveShapeSite } = await import("../helpers/ashby_live_shape.ts");
    const { dryEngine, dryRunLoop } = await import("../../scripts/career/ramp-dry-run.ts");
    const persona = JSON.parse(await Deno.readTextFile(`${ROOT}/tests/fixtures/ramp/persona-test.json`));
    const site = ashbyLiveShapeSite();
    const work = await Deno.makeTempDir({ prefix: "ramp-card-" });
    try {
      await Deno.writeTextFile(`${work}/${persona.file.name}`, persona.file.text);
      const engine = dryEngine({ extra: ["--script-submit", "ashby", "--state-dir", `${work}/state`], evidenceRoot: `${work}/ev` });
      const r = await dryRunLoop({ url: site.form, userId: "TEST-ramp-card", company: "Ramp", persona, resumePath: `${work}/${persona.file.name}`, work, runEngine: engine });
      eq(r.status, "ready", JSON.stringify(r));
      const schema: any[] = r.payload.approved_snapshot.schema, card: string[] = r.card!;
      const sms = schema.find((s) => s.name === "communicationConsent"), wa = schema.find((s) => s.name === "whatsappConsent");
      eq(sms.label, "Check Yes or No to indicate your agreement to receive text message updates from Ramp regarding your job application.", "the SMS consent's own question, from the page");
      eq(wa.label, "Yes - I consent to receiving WhatsApp messages / No - I do not consent to receiving WhatsApp messages", "no question on the page: named by its choices");
      for (const f of r.payload.fields.filter((x: any) => /consent|sponsorship|New York/i.test(x.label + x.name))) {
        const s = schema.find((x) => x.name === f.name);
        const lines = card.filter((l) => l.includes(`${f.label}: `));
        eq(lines.length, 1, `one line for ${f.label}: ${card.join(" | ")}`);
        const shown = lines[0].slice(lines[0].indexOf(`${f.label}: `) + f.label.length + 2);
        const sent = s.options.find((o: any) => o.value === f.value);
        const want = sent ? sent.label : s.type === "checkbox" ? (/^(yes|true)$/i.test(String(f.value)) ? "Yes (checked)" : "No") : String(f.value);
        eq(shown, want, `${f.label}: the card shows the choice whose code is sent (${f.value})`);
        assert(!s.options.some((o: any) => o.label === f.label), `the question is not one of its options: ${f.label}`);
      }
      // The defect as the owner would have read it: one option shown as the question, the other as the answer.
      assert(!card.some((l) => /^You agree: Yes - I consent to receiving [^/:]*: No - /.test(l)), card.join(" | "));
    } finally {
      await site.close();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
