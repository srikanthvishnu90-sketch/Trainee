// WO-049: a written answer drafted ON THE EXTENSION'S CARD, from the person's confirmed facts, on their tap, shown in
// full, used only when they say so. The edge function's pure core (supabase/functions/_shared/career_essay_card.ts) with a
// stub model, and the card's pure half (extension/src/apply_core.ts). Real wording from the captured CI question sets.
// No model, no network, no database.
import CI_A from "../../evals/apply/questions-ci.json" with { type: "json" };
import CI_B from "../../evals/apply/questions-ci-b.json" with { type: "json" };
import REPORT from "../../docs/apply/fill-coverage.md" with { type: "text" };
import { fillCoverage } from "../../evals/apply/fill-coverage.ts";
import {
  type CardReply, DAILY_DRAFTS, type DraftCounter, essayCardDraft, type EssayCardDeps, essayModelConfig, factLabel, handleEssayDraft,
  readRequest, supabaseDraftCounter, supabaseFacts,
} from "../../supabase/functions/_shared/career_essay_card.ts";
import {
  cardLines, draftFactId, draftFactIds, draftProvenance, essayQuestions, OWN_WORDS_BANNED, OWN_WORDS_UNREAD, evidenceRecord, formAnswersToKeep, reviewPayload, showableDraft,
  type SnapField,
} from "../../extension/src/apply_core.ts";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { callModel } from "../../supabase/functions/_shared/model_gateway.ts";
import { fakeAnthropic } from "./helpers/fake_anthropic.ts";
import FN_SRC from "../../supabase/functions/career-essay-draft/index.ts" with { type: "text" };
import CORE_SRC from "../../supabase/functions/_shared/career_essay_card.ts" with { type: "text" };
import CONFIG from "../../supabase/config.toml" with { type: "text" };
import BACKGROUND from "../../extension/background.js" with { type: "text" };
import CONTENT from "../../extension/content.js" with { type: "text" };
import PANEL from "../../extension/panel.js" with { type: "text" };

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const T = Date.UTC(2026, 9, 20, 15);
const labelsOf = (p: any) => p.fields.map((f: any) => String(f.label));
const CANONICAL = (CI_A as any).postings.find((p: any) => p.company === "Canonical");
const canonicalBan = labelsOf(CANONICAL).find((l: string) => /only my own words/.test(l))!;

// The person's account, as the server reads it: confirmed facts, one still waiting for their yes, a bare skill.
const FACTS = [
  { id: "F-001", kind: "experience", text: "Senior accountant at Brightline Health, 2021 to 2024; closed the monthly books in 5 days instead of 9", needs_confirmation: false, status: "confirmed" },
  { id: "F-002", kind: "project", text: "Built a NetSuite to Snowflake reconciliation in Python that cut manual matching by 40%", needs_confirmation: false, status: "confirmed" },
  { id: "F-003", kind: "education", text: "B.S. Accounting, University of Iowa, 2019", needs_confirmation: false, status: "confirmed" },
  { id: "F-004", kind: "preference", text: "Wants to build finance software used by controllers", needs_confirmation: false, status: "confirmed" },
  { id: "F-005", kind: "experience", text: "Led a team of 12 engineers at Stripe as engineering manager", needs_confirmation: true, status: "draft" },
  { id: "F-006", kind: "skill", name: "Python", text: "Skill: Python", evidence: [] },
];
const CLEAN =
  "At Brightline Health I was the senior accountant who got our monthly close from 9 days to 5. I built a NetSuite to Snowflake reconciliation in Python that cut manual matching by 40%, and I want to build finance software used by controllers.";
const SHORT = "At Brightline Health I closed the monthly books in 5 days instead of 9, and I want to build finance software used by controllers.";
const INVENTED = "At Stripe I led a team of 12 engineers as engineering manager and doubled revenue to $2M using Kubernetes.";

function stub(...answers: (string | Error | { text: string; stop: string })[]) {
  const calls: any[] = [];
  const model = async (payload: any) => {
    calls.push(payload);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    const text = typeof a === "string" ? a : a.text;
    return { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: typeof a === "string" ? "end_turn" : a.stop };
  };
  return { model, calls };
}
function counter(start = 0) {
  const rows: { id: string; at: string }[] = Array.from({ length: start }, (_, i) => ({ id: `old-${i}`, at: new Date(T - 3600_000).toISOString() }));
  const c: DraftCounter & { rows: typeof rows; released: string[]; extra: number; onReserve: () => void } = {
    rows, released: [], extra: 0, onReserve: () => {},
    async used(_u, since) { return rows.filter((r) => r.at >= since).length + c.extra; },
    async reserve(_u, at) { const id = `r-${rows.length}`; rows.push({ id, at }); c.onReserve(); return id; },
    async release(id) { c.released.push(id); const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
  };
  return c;
}
function deps(o: { model: any; facts?: unknown[]; counter?: ReturnType<typeof counter> }) {
  const reads: string[] = [];
  const d: EssayCardDeps & { reads: string[] } = {
    reads,
    facts: async (u) => { reads.push(u); return o.facts ?? FACTS; },
    model: o.model, counter: o.counter ?? counter(), now: () => T,
  };
  return d;
}
const WHY = "Why do you want to work at Ramp?";
const ask = (o: Record<string, unknown> = {}) => ({ posting: "ashby:ramp:1", company: "Ramp", label: WHY, type: "textarea", siblings: ["First name", "Email"], limit: {}, ...o });
// The facts block the model is given ("- [F-001, experience] ..." lines).
const factLines = (call: any) => String(call.messages[0].content).split("\n").filter((l: string) => l.startsWith("- [")).join("\n");
const notShown = (r: CardReply) => !("text" in r) && !/Brightline Health I|Stripe I led/.test(JSON.stringify(r));

// ---------------------------------------------------------------------------------------------------------------------
Deno.test("WO-049/1 the employer's AI policy decides first: a form that asks for your own words is refused, no facts read, no model call, no count", async () => {
  const m = stub(CLEAN), c = counter(), d = deps({ model: m.model, counter: c });
  const r = await essayCardDraft("u1", ask({ company: "Canonical", posting: CANONICAL.id, label: "Describe any publicly listed company experience you have.", siblings: [canonicalBan, "Email"] }), d);
  eq([r.ok, (r as any).why], [false, "policy"]);
  assert(/^Canonical asks for answers written without AI \("During this application process I agree to use only my own words/.test(r.message), r.message);
  assert(!r.message.includes("\n"), "one line");
  eq(m.calls.length, 0, "the model is never called");
  eq(d.reads.length, 0, "the facts are not even read");
  eq(c.rows.length, 0, "a refusal is not a draft");
  // A ban inside the question itself, and Anthropic's bare named policy, refuse too.
  const r2 = await essayCardDraft("u1", ask({ label: "Why us? Please answer in your own words without using ChatGPT or other AI tools." }), d);
  eq((r2 as any).why, "policy");
  const r3 = await essayCardDraft("u1", ask({ company: "Anthropic", label: "Why Anthropic?", siblings: ["AI Policy for Application"] }), d);
  eq((r3 as any).why, "policy");
  assert(/names its own AI policy/.test(r3.message), r3.message);
  eq(m.calls.length, 0);
});

Deno.test("WO-049/2 thin facts: fewer than 2 confirmed facts fit, so no model call, and the card says what would help", async () => {
  const m = stub(CLEAN);
  const r = await essayCardDraft("u1", ask(), deps({ model: m.model, facts: [FACTS[0], FACTS[4], FACTS[5]] }));
  eq([r.ok, (r as any).why], [false, "thin"]);
  eq(m.calls.length, 0, "no model call");
  assert(/^Only 1 of your confirmed facts fit this question and Trainee needs 2, so nothing was drafted\. Tell Trainee a job or project you're proud of/.test(r.message), r.message);
  assert(/what draws you to Ramp/.test(r.message), "whatWouldHelp, for this employer");
  assert(!r.message.includes("\n"));
});

Deno.test("WO-049/3 a draft that fails the fact-lock twice is not shown: no text, the question stays the person's", async () => {
  const m = stub(INVENTED, INVENTED);
  const r = await essayCardDraft("u1", ask(), deps({ model: m.model }));
  eq([r.ok, (r as any).why], [false, "unverified"]);
  eq(m.calls.length, 2, "written once more with the failing items named, then given up");
  assert(/Stripe/.test(m.calls[1].messages[0].content), "the retry names what failed");
  assert(notShown(r), "the draft text never reaches the card");
  assert(/^No draft shown: it kept naming things you haven't confirmed \(/.test(r.message), r.message);
  // Once wrong, then clean: the clean one is shown, the wrong one never.
  const m2 = stub(INVENTED, CLEAN);
  const ok = await essayCardDraft("u1", ask(), deps({ model: m2.model }));
  eq([ok.ok, (ok as any).text], [true, CLEAN]);
});

Deno.test("WO-049/4 the form's limit is met by writing again, never by cutting; a cut-off draft is never shown", async () => {
  // The field's maxlength (sent by the card as limit.chars) is a limit even when the label states none.
  const m = stub(CLEAN, SHORT);
  const r = await essayCardDraft("u1", ask({ limit: { chars: 150 } }), deps({ model: m.model }));
  eq([r.ok, (r as any).text], [true, SHORT], "the second, shorter draft, whole");
  eq(m.calls.length, 2);
  assert(/at most 150 characters/.test(m.calls[0].messages[0].content), "the model is told the field's limit");
  assert(/too long/.test(m.calls[1].messages[0].content), "and told again why it was rejected");
  assert(!CLEAN.startsWith((r as any).text.slice(0, 60)), "not the first draft cut short");
  // A limit in the label itself.
  const m2 = stub(CLEAN, SHORT);
  eq((await essayCardDraft("u1", ask({ label: "Why do you want to work at Ramp? (in 30 words or less)" }), deps({ model: m2.model })) as any).text, SHORT);
  // Too long twice: nothing shown, never a cut.
  const m3 = stub(CLEAN, CLEAN);
  const r3 = await essayCardDraft("u1", ask({ limit: { chars: 100 } }), deps({ model: m3.model }));
  eq((r3 as any).why, "too_long");
  assert(notShown(r3));
  // Cut off by the token limit twice: never shown.
  const m4 = stub({ text: "At Brightline Health I closed the monthly books in 5 days instead of 9 and", stop: "max_tokens" });
  const r4 = await essayCardDraft("u1", ask(), deps({ model: m4.model }));
  eq([r4.ok, (r4 as any).why], [false, "too_long"]);
  assert(!("text" in r4));
});

Deno.test("WO-049/5 at most 60 drafts a person in 24 hours, counted on the server once per draft, said plainly; two taps at once never pass it", async () => {
  eq(DAILY_DRAFTS, 60);
  // 60 already: refused before anything is read or called.
  const m = stub(CLEAN), full = counter(60), d = deps({ model: m.model, counter: full });
  const r = await essayCardDraft("u1", ask(), d);
  eq([r.ok, (r as any).why, (r as any).used, (r as any).cap], [false, "cap", 60, 60]);
  assert(/^You've had 60 drafts in the last 24 hours, Trainee's daily limit, so nothing was drafted\./.test(r.message), r.message);
  eq([m.calls.length, d.reads.length], [0, 0]);
  // 59: this one goes, and counts once even though it took two tries.
  const c = counter(59), m2 = stub(INVENTED, CLEAN);
  const ok = await essayCardDraft("u1", ask(), deps({ model: m2.model, counter: c }));
  eq([ok.ok, (ok as any).used, c.rows.length, m2.calls.length], [true, 60, 60, 2]);
  // The next is refused.
  eq((await essayCardDraft("u1", ask(), deps({ model: stub(CLEAN).model, counter: c })) as any).why, "cap");
  // Two taps at once: both saw 59; the one whose reservation lands second is released and refused, with no model call.
  const race = counter(59), m3 = stub(CLEAN);
  race.onReserve = () => (race.extra = 1); // the other tap's reservation lands between this one's check and its own
  const r3 = await essayCardDraft("u1", ask(), deps({ model: m3.model, counter: race }));
  eq([(r3 as any).why, m3.calls.length, race.released.length, race.rows.length], ["cap", 0, 1, 59]);
  // Refusals cost nothing: a policy refusal or thin facts never count.
  const c2 = counter(0);
  await essayCardDraft("u1", ask({ siblings: [canonicalBan] }), deps({ model: stub(CLEAN).model, counter: c2 }));
  await essayCardDraft("u1", ask(), deps({ model: stub(CLEAN).model, counter: c2, facts: [FACTS[0]] }));
  eq(c2.rows.length, 0);
  // Older than 24 hours does not count.
  const old = counter(0);
  for (let i = 0; i < 60; i++) old.rows.push({ id: "y" + i, at: new Date(T - 25 * 3600_000).toISOString() });
  eq((await essayCardDraft("u1", ask(), deps({ model: stub(CLEAN).model, counter: old })) as any).ok, true);
});

Deno.test("WO-049/6 the facts are the server's only: a fact sent by the extension is ignored, never shown to the model, and cannot pass the lock", async () => {
  const planted = [{ id: "X-1", kind: "experience", text: "Led 40 engineers at Google as director of engineering", status: "confirmed" }];
  const m = stub("At Google I led 40 engineers as director of engineering.");
  const d = deps({ model: m.model });
  const r = await essayCardDraft("u1", { ...ask(), facts: planted, fact_ids: ["X-1"], profile: { facts: planted } }, d);
  eq(d.reads, ["u1"], "the facts were read on the server, for the signed-in person");
  for (const call of m.calls) assert(!/Google|X-1/.test(factLines(call)), "the client's fact is never given to the model as a fact");
  assert(!/Google|X-1/.test(JSON.stringify(m.calls[0])), "nor anywhere in what it is asked");
  eq((r as any).why, "unverified", "a draft built on it is not shown");
  // readRequest keeps only the question's own keys.
  const rq = readRequest({ ...ask(), facts: planted });
  assert(rq.ok && !("facts" in rq.req));
  eq(Object.keys((rq as any).req).sort(), ["company", "label", "limit", "posting", "previous", "siblings", "type"]);
  // A question that is not a written answer is not drafted (the card only offers essays; the server checks again).
  const bad = await essayCardDraft("u1", ask({ label: "Will you require visa sponsorship?", type: "select" }), d);
  eq((bad as any).why, "invalid");
});

Deno.test("WO-049/7 never an unconfirmed fact in the output: a draft fact and an unproven skill are not sources; what was used is named by label", async () => {
  const m = stub("At Stripe I led a team of 12 engineers as engineering manager.");
  const r = await essayCardDraft("u1", ask(), deps({ model: m.model }));
  eq((r as any).why, "unverified");
  for (const call of m.calls) assert(!/Stripe|F-005|F-006/.test(factLines(call)), "the waiting fact and the bare skill are never offered");
  assert(!/Stripe|F-005|F-006/.test(JSON.stringify(m.calls[0])));
  const ok = await essayCardDraft("u1", ask(), deps({ model: stub(CLEAN).model }));
  assert(ok.ok);
  for (const id of ok.fact_ids) assert(["F-001", "F-002", "F-003", "F-004"].includes(id), id);
  eq(ok.facts.map((f) => f.id), ok.fact_ids);
  for (const f of ok.facts) assert(f.label.length <= 80 && !f.label.includes("instead of 9"), `a label, not the whole fact: ${f.label}`);
  eq(factLabel({ kind: "project", label: "Reconciliation build" }), "Reconciliation build");
  assert(/^Drafted by Trainee only from your confirmed facts\. Ramp's form doesn't say whether AI help is allowed/.test(ok.message), ok.message);
  // Redo: the previous draft goes to the model as the one to differ from.
  const m2 = stub(SHORT);
  const redo = await essayCardDraft("u1", ask({ previous: CLEAN }), deps({ model: m2.model }));
  eq((redo as any).text, SHORT);
  assert(m2.calls[0].messages[0].content.includes(`Write a different version from this earlier one:\n${CLEAN}`));
});

Deno.test("WO-049/8 the edge: the person's own session only, POST only, JSON; Claude only, whatever MODEL_PROVIDER says", async () => {
  const cors = { "Access-Control-Allow-Origin": "x" };
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  const person = `${b64({ alg: "none" })}.${b64({ role: "authenticated", sub: "u1" })}.sig`;
  const service = `${b64({ alg: "none" })}.${b64({ role: "service_role" })}.sig`;
  const m = stub(CLEAN);
  const h = (token: string | null, body: unknown, method = "POST") =>
    handleEssayDraft(new Request("https://x.test/functions/v1/career-essay-draft", { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: method === "POST" ? JSON.stringify(body) : undefined }), {
      cors, user: async (t) => (t === person ? { id: "u1" } : null), card: () => deps({ model: m.model }),
    });
  eq((await h(null, ask())).status, 401);
  eq((await h(service, ask())).status, 403, "a service key is not a person");
  eq((await h("not.a.jwt", ask())).status, 403);
  eq((await h(person, null)).status, 400);
  eq((await h(person, ask(), "GET")).status, 405);
  const res = await h(person, ask());
  eq(res.status, 200);
  const body = await res.json();
  eq([body.ok, body.text], [true, CLEAN]);
  eq(res.headers.get("access-control-allow-origin"), "x");
  // Claude only, whatever MODEL_PROVIDER says.
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  eq(essayModelConfig(env({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" })).provider, "anthropic");
  eq(essayModelConfig(env({ OPENAI_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" })).apiKey, "k2");
  eq(essayModelConfig(env({ OPENAI_API_KEY: "k1" })).apiKey, "", "an OpenAI key is not a key: not configured");
  eq(essayModelConfig(env({ ANTHROPIC_API_KEY: "k2", CAREER_MODEL: "claude-sonnet-5-5" })).model, "claude-sonnet-5-5");
  eq(essayModelConfig(env({ ANTHROPIC_API_KEY: "k2", CAREER_MODEL: "gpt-5-mini" })).model, "claude-sonnet-5-5", "a gpt id never moves the essay off Claude");
  for (const src of [FN_SRC, CORE_SRC]) {
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert(!/openai|api\.anthropic|ANTHROPIC_API_KEY|OPENAI_API_KEY/i.test(code), "no provider URL or key in the function: only the gateway names them");
    assert(!/gpt-|claude-|\bo\d-/i.test(src), "no model identifier in the function");
  }
  assert(/callModel\(cfg, payload/.test(FN_SRC) && /essayModelConfig\(Deno\.env\)/.test(FN_SRC), "the gateway's callModel with the pinned config");
  assert(/\[functions\.career-essay-draft\]\s*\nverify_jwt = true/.test(CONFIG), "the gateway checks the JWT too");
});

Deno.test("WO-049/9 the server's stores: facts from every thread of the person, newest first, one per id; the counter is the person's own timeline", async () => {
  const calls: any[] = [];
  // A query builder that records every call and resolves to `data` when awaited.
  const chainOf = (data: any, log: any[]) => {
    const q: any = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: any) => res(data) : (...a: any[]) => (log.push([k, ...a]), q)) });
    return q;
  };
  const chain = (data: any) => chainOf(data, calls);
  const rows = [
    { facts: [FACTS[0], { ...FACTS[1], text: "newest wins" }], updated_at: "2026-10-20" },
    { facts: [FACTS[1], FACTS[2]], updated_at: "2026-10-01" },
    { facts: null, updated_at: "2026-09-01" },
  ];
  const admin = { from: (t: string) => (calls.push(["from", t]), chain({ data: rows, error: null })) };
  const got = await supabaseFacts(admin)("u1");
  eq((got as any[]).map((f) => f.id), ["F-001", "F-002", "F-003"]);
  eq((got as any[])[1].text, "newest wins");
  assert(calls.some((c) => c[0] === "eq" && c[1] === "user_id" && c[2] === "u1"), "scoped to the person");
  assert(calls.some((c) => c[0] === "select" && /state->career->stores->profile->facts/.test(c[1])));
  // The counter: career_events, kind note, source essay_card, the person's own.
  const ccalls: any[] = [];
  const cadmin = { from: (t: string) => (ccalls.push(["from", t]), chainOf({ count: 7, data: { id: 9 }, error: null }, ccalls)) };
  const ctr = supabaseDraftCounter(cadmin);
  eq(await ctr.used("u1", "2026-10-19T15:00:00.000Z"), 7);
  eq(await ctr.reserve("u1", "2026-10-20T15:00:00.000Z", { posting: "p", company: "Ramp", label: WHY }), "9");
  const flat = JSON.stringify(ccalls);
  for (const s of ['["from","career_events"]', '["eq","kind","note"]', '["eq","source","essay_card"]', '["eq","user_id","u1"]', '["gte","at","2026-10-19T15:00:00.000Z"]']) {
    assert(flat.includes(s), s);
  }
});

// ------------------------------------------------------------------------------------------------ the card's pure half
const snap = (o: Partial<SnapField>): SnapField => ({ name: "n", label: "L", value: "v", source: "trainee", factId: "F", masked: false, ...o });
const payloadOf = (fields: SnapField[]) => reviewPayload({ userId: "u1", jobId: "ashby:ramp:1", company: "ramp", url: "https://jobs.ashbyhq.com/ramp/1/application", family: "ashby",
  fields, resume: null, account: { epoch: 0, version: 1 }, expiresAt: "2026-10-20T17:00:00.000Z" });

Deno.test("WO-049/10 the card offers a draft on each written question still needed, and only there", () => {
  const schema = [
    { name: "why", label: "Why do you want to work here?*", type: "textarea", required: true },
    { name: "exp", label: "Describe your experience with reconciliation.", type: "textarea", required: true },
    { name: "opt", label: "Why do you want to work here?", type: "textarea", required: false },
    { name: "spons", label: "Will you require sponsorship?", type: "select", required: true, options: [{ label: "Yes", value: "1" }, { label: "No", value: "0" }] },
    { name: "first", label: "First name", type: "text", required: true },
    { name: "mine", label: "What are you most proud of?", type: "textarea", required: true },
  ] as any[];
  const fields = [{ name: "first", source: "trainee" }, { name: "mine", source: "you" }, { name: "exp", source: "drafted" }];
  eq(essayQuestions({ schema, fields, maxLength: { why: 1200 } }), [
    { name: "why", label: "Why do you want to work here?*", type: "textarea", chars: 1200, own: null },
    { name: "exp", label: "Describe your experience with reconciliation.", type: "textarea", chars: null, own: null },
  ], "required essays not answered, and a used draft (still editable); never one the person typed, never an optional one");
  // Shown only when the server said ok and the text is whole.
  assert(showableDraft({ ok: true, text: SHORT, fact_ids: ["F-001"], facts: [], message: "" }));
  for (const bad of [{ ok: false, why: "unverified", message: "x" }, { ok: true, text: "At Brightline Health I closed the", fact_ids: [] }, { ok: true, text: "", fact_ids: [] },
    { ok: true, text: "x".repeat(2001) + ".", fact_ids: [] }, null, { ok: true, text: SHORT }]) assert(!showableDraft(bad), JSON.stringify(bad).slice(0, 80));
  // The facts it came from ride the payload's factId.
  eq(draftFactIds(draftFactId(["F-001", "F-004"])), ["F-001", "F-004"]);
  eq(draftFactIds("text-answer:1"), []);
  assert(draftFactId(Array.from({ length: 80 }, (_, i) => `F-${i}`)).length <= 200);
});

Deno.test("WO-049/11 a used draft is in the approved payload and its hash; the card and the proof say it was drafted from the facts and used (or edited) by the person", async () => {
  const essay = snap({ name: "why", label: "Why do you want to work here?", value: CLEAN, source: "drafted", factId: draftFactId(["F-001", "F-002"]) });
  const p = payloadOf([snap({ name: "first", label: "First name", value: "Test" }), essay]);
  const edited = payloadOf([snap({ name: "first", label: "First name", value: "Test" }), { ...essay, value: CLEAN + " I also mentor juniors." }]);
  const { approvalHash } = await import("../../extension/src/apply_core.ts");
  assert((await approvalHash(p)) !== (await approvalHash(edited)), "an edit is a different approval");
  const lines = cardLines({ company: "ramp", family: "ashby", payload: p, openRequired: [], identity: [], blockers: [], verification: [] });
  assert(lines.some((l) => l === `Why do you want to work here?: ${CLEAN} (drafted by Trainee from your confirmed facts F-001, F-002; put on the form by you)`), lines.join("\n"));
  const drafts = { why: { original: CLEAN, factIds: ["F-001", "F-002"] } };
  eq(draftProvenance(p.fields, drafts).why, { fact_ids: ["F-001", "F-002"], edited: false, said: "drafted by Trainee from your facts (F-001, F-002), used by you as drafted" });
  eq(draftProvenance(edited.fields, drafts).why.said, "drafted by Trainee from your facts (F-001, F-002), edited and used by you");
  const ev = await evidenceRecord({ payload: edited, hash: "h", outcome: { state: "confirmed", reason: "r", confirmation_id: null }, pageText: "Thanks", urlAfter: "https://x.test",
    screenshotSha256: null, screenshotAfterSha256: null, times: { card: T, approved: T, clicked: T, done: T }, drafts });
  const a = (ev.answers as any[]).find((x) => x.label === "Why do you want to work here?");
  eq([a.source, a.fact_ids, a.edited, a.provenance], ["drafted", ["F-001", "F-002"], true, "drafted by Trainee from your facts (F-001, F-002), edited and used by you"]);
  eq((ev.answers as any[])[0].provenance, undefined, "only drafted answers carry it");
});

Deno.test("WO-049/12 a used essay is kept for this posting only (job:), never as a fact or a wording that travels", () => {
  const label = "Why do you want to work here?";
  const needs = [{ label, type: "textarea", options: [] }, { label: "Describe your experience with reconciliation.", type: "textarea", options: [] }];
  const kept = formAnswersToKeep({ jobId: "ashby:ramp:1", company: "Ramp", needs, answers: {}, answered: new Set(), fields: [
    { name: "why", label, value: CLEAN, source: "drafted" },
    { name: "exp", label: "Describe your experience with reconciliation.", value: SHORT, source: "drafted" },
  ] });
  eq(kept.answers.length, 2);
  for (const a of kept.answers) {
    assert(/^job:[0-9a-f]{16}$/.test(a.key), `${a.label}: ${a.key}`);
    eq(a.key, answerKey({ label: a.label, type: a.type }, "ashby:ramp:1"));
  }
  // A drafted answer under a question the map would key by wording (not an essay by its type) is not kept at all.
  const odd = formAnswersToKeep({ jobId: "ashby:ramp:1", company: "Ramp", answers: {}, answered: new Set(),
    needs: [{ label: "Anything else we should know?", type: "input_text", options: [] }],
    fields: [{ name: "x", label: "Anything else we should know?", value: SHORT, source: "drafted" }] });
  eq(odd.answers, []);
  // The person's own typed answer to a wording question still travels as before (WO-042).
  const typed = formAnswersToKeep({ jobId: "ashby:ramp:1", company: "Ramp", answers: {}, answered: new Set(),
    needs: [{ label: "Anything else we should know?", type: "input_text", options: [] }],
    fields: [{ name: "x", label: "Anything else we should know?", value: "No", source: "you" }] });
  assert(/^label:/.test(typed.answers[0].key));
});

Deno.test("WO-049/13 the extension wiring: no draft without the person's own tap; the panel asks the background, the background asks the function; Use this fills through the content script", () => {
  // The panel's buttons act only on trusted clicks and inputs, and only the panel may ask for a draft or use one.
  assert(/essay-draft[\s\S]{0,400}isTrusted|isTrusted[\s\S]{0,400}essay-draft/.test(PANEL), "Draft acts on the person's own click only");
  assert(/essay-use/.test(PANEL) && /isTrusted/.test(PANEL));
  const panelOnly = BACKGROUND.slice(BACKGROUND.indexOf("const PANEL_ONLY"), BACKGROUND.indexOf("const TAB_ONLY"));
  assert(/"essay-draft"/.test(panelOnly) && /"essay-use"/.test(panelOnly), "draft and use are the panel's only");
  assert(/\/functions\/v1\/career-essay-draft/.test(BACKGROUND), "the background calls the function");
  assert(!/facts:/.test(BACKGROUND.slice(BACKGROUND.indexOf("async function requestDraft"), BACKGROUND.indexOf("async function requestDraft") + 1500)), "and never sends facts to it");
  // The content script never asks for a draft by itself, and fills one only when the background says the person used it.
  assert(!/essay-draft/.test(CONTENT), "the page side never requests a draft");
  assert(/m\?\.type === "essay-fill"/.test(CONTENT));
  assert(/source === "drafted"|"drafted"/.test(CONTENT));
});

Deno.test("WO-049/14 measured: essays offered a draft are a separate column, never counted as filled", () => {
  for (const [name, set] of [["A", CI_A], ["B", CI_B]] as const) {
    const c = fillCoverage(set as any);
    const asked = Object.values(c.askedKinds).reduce((x: number, y: any) => x + y, 0);
    eq(c.filled + asked, c.required, `${name}: a drafted essay is still asked, not filled`);
    eq(c.drafted + c.essayPolicy, c.askedKinds.essay ?? 0, `${name}: every asked essay is either offered a draft or kept for the person's words`);
    assert(c.drafted >= 20, `${name}: ${c.drafted}`);
    assert(REPORT.includes(`| ${c.drafted} of ${c.askedKinds.essay} essays |`), "docs/apply/fill-coverage.md is stale: regenerate it");
  }
  assert(/\| Drafted for review \|/.test(REPORT));
});

Deno.test("WO-049/15 the card reads the employer's AI policy itself: a form that asks for the person's own words offers no draft", () => {
  const essay = { name: "why", label: "Why do you want to work here?", type: "textarea", required: true };
  const ban = { name: "ack", label: "I confirm my answers are only my own words, written without AI tools.", type: "checkbox", required: true };
  const vague = { name: "pol", label: "I have read the Acme AI Policy.", type: "checkbox", required: true };
  eq(essayQuestions({ schema: [essay] as any, fields: [] })[0].own, null, "no policy: a draft may be offered");
  eq(essayQuestions({ schema: [essay, ban] as any, fields: [] })[0].own, OWN_WORDS_BANNED);
  eq(essayQuestions({ schema: [essay, vague] as any, fields: [] })[0].own, OWN_WORDS_UNREAD);
  assert(/q\.own/.test(PANEL) && /if \(q\.own\)/.test(PANEL), "the card hides the button and shows the reason");
});

Deno.test("WO-049/16 the essay draft goes through the gateway to api.anthropic.com only, on the Claude reader model", async () => {
  const wire = fakeAnthropic(() => CLEAN);
  const cfg = essayModelConfig({ get: (k: string) => ({ OPENAI_API_KEY: "sk-openai-not-used", ANTHROPIC_API_KEY: "sk-ant-test", CAREER_MODEL: "gpt-5-mini" } as Record<string, string>)[k] });
  const d = deps({ model: (payload: any) => callModel(cfg, payload, { role: "chat", request: wire.request }) });
  const r = await essayCardDraft("u1", ask(), d);
  eq((r as any).text, CLEAN);
  eq([wire.urls, wire.bodies[0].model, wire.headers[0]["x-api-key"], wire.onlyAnthropic()], [["https://api.anthropic.com/v1/messages"], "claude-sonnet-5-5", "sk-ant-test", true]);
});
