// WO-051: a model's second opinion on the mail the rules are unsure of, behind CAREER_MAIL_MODEL (off by default).
// Stub models only: no network, no key, no spend. Covers: off is byte-identical on every committed split; only uncertain
// mail is asked; what is sent; the strict answer schema; every safety rule after the answer; the daily cap counted in the
// store; the cost row; the eval's NOT_RUN without a key; the owner's pending decision.
// Run: deno test -A --no-check tests/architect/wo-051-mail-model.test.ts
import { classifyMail, decidedAs, type MailIn, type MailMeta, planUpdates, type TrackedApp } from "../../supabase/functions/_shared/career_mail.ts";
import { certainty, MAIL_MODEL_DAILY_CAP, MAIL_MODEL_MAX_CALLS, MAIL_VERDICT_FORMAT, mailModelPayload, mailModelWiring, opinion, secondPass, toAsk, UNCERTAIN } from "../../supabase/functions/_shared/career_mail_model.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { allSplits, HELD_OUT, selection, withModel } from "../../evals/career/mail-model-eval.ts";
import { fakeAnthropic } from "./helpers/fake_anthropic.ts";
import MODEL_SRC from "../../supabase/functions/_shared/career_mail_model.ts" with { type: "text" };
import INDEX_SRC from "../../supabase/functions/career-proactive/index.ts" with { type: "text" };
import MIGRATION from "../../supabase/migrations/20261021130000_career_mail_model_calls.sql" with { type: "text" };
import DECISIONS from "../../docs/architect/DECISIONS.md" with { type: "text" };

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const DAY = 86400000;
const NOW = Date.parse("2026-10-20T15:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const AUTH = (domain: string) => [`mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT) header.from=${domain}`];
const domainOf = (from: string) => (/@([^>\s]+)/.exec(from)?.[1] ?? "").toLowerCase();
const mailIn = (hash: string, from: string, subject: string, snippet: string, o: { at?: number; auth?: boolean } = {}): MailIn =>
  ({ hash, from, subject, snippet, date: iso(o.at ?? NOW - 2 * 60000), auth: o.auth === false ? [] : AUTH(domainOf(from)) });
const app = (ref: string, company: string, more: Partial<TrackedApp> = {}): TrackedApp =>
  ({ ref, company, stage: "Submitted", source: "queue", applied_at: iso(NOW - 10 * DAY), events: [], ...more });
const say = (kind: string, confidence = 0.97) => async () => ({ content: [{ type: "text", text: JSON.stringify({ kind, confidence }) }] });
const v = (kind: any, confidence = 0.97) => ({ kind, confidence });

const GH = "Asana <no-reply@greenhouse.io>";
const ASANA = [app("job:9", "Asana", { role: "Account Manager", url: "https://boards.greenhouse.io/asana/jobs/9" })];
// The rules: sure of these two.
const CLEAR_NO = mailIn("c1", GH, "Your Asana application", "Unfortunately, we have decided not to move forward with your application.");
const SURE_IV = mailIn("c2", GH, "Interview invitation: Asana Account Manager", "We would like to invite you to interview for the Account Manager role. Please pick a time.");
// Unsure of these: "other" with a step word (WO-040's ambiguous), and three thin readings.
const VAGUE = mailIn("u1", GH, "Asana - update on your application", "Hi Sam, thanks for your patience. We have news about the Account Manager role; please see the portal.");
const WEAK_IV = mailIn("u2", GH, "Asana - Account Manager", "Thanks for applying. If your background fits, we will reach out to schedule an interview for the Account Manager role.");
const WEAK_AS = mailIn("u3", GH, "Asana - Account Manager", "We'd love to hear more. Please complete a short questionnaire about the Account Manager role by Friday.");
// "other", but with words that decide against the person (the role is filled), and a call offered.
const FILLED = mailIn("u4", GH, "Asana - your application", "Thanks for applying to the Account Manager role. Unfortunately the role has been filled, but our recruiter would like to set up a call about other openings.");
// A scheduling tool that names no job, and a calendar invitation.
const GOODTIME = mailIn("g1", "Asana via GoodTime <scheduling@goodtime.io>", "Your Asana interviews are confirmed", "Your interviews with Asana are confirmed for Tuesday; please review your application details.");
const CALENDAR = mailIn("g2", "Google Calendar <calendar-notification@google.com>", "Invitation: Interview with Priya @ Tue Oct 21 2pm", "Priya Raman has invited you to Interview with Priya about your application. Join with Google Meet.");
// Forwards, with and without the original sender shown.
const FWD_SHOWN = mailIn("f1", "Sam Lee <sam.lee@gmail.com>", "Fwd: Asana - update on your application", "---------- Forwarded message --------- From: Asana <no-reply@greenhouse.io> Subject: Asana - update on your application. Hi Sam, thanks for your patience. We have news about the Account Manager role; please see the portal.");
const FWD_BARE = mailIn("f2", "Sam Lee <sam.lee@gmail.com>", "Fwd: Asana - update on your application", "see below. Hi Sam, thanks for your patience. We have news about the Account Manager role; please see the portal.");

// ------------------------------------------------------------------------------------------------ E: off is today
// sha256 of every committed split's classifications (2564 emails), taken at the branch point 4e79ef0f before any WO-051
// change. The second opinion lives outside the classifier; this pins that the rules read every email exactly as before.
// Family email (2026-10-26): one reading's evidence changed and no kind did. The Spanish "nos gustaría invitarte a una
// entrevista" became a decisive interview phrase (career_mail_langs.ts), so mail-blind240 C234 (interview before and after)
// now cites that phrase; every other one of the 2564 readings is byte-identical to the previous golden (ee59cb5e...).
const GOLDEN = { n: 2564, sha256: "0a951cbc0d8d1654644f25604e0601be9b4f0ca4af1235e2b5539fcdbacc42e0" };
const FILES = ["mail-labels", "mail-blind", "mail-dev4", "mail-blind160", "mail-dev5", "mail-blind200", "mail-dev6", "mail-blind240", "mail-dev7", "mail-blind300"];
async function committed(): Promise<{ file: string; mails: any[] }[]> {
  const out = [];
  for (const f of FILES) out.push({ file: f, mails: JSON.parse(await Deno.readTextFile(new URL(`../../evals/career/${f}.json`, import.meta.url))).mails });
  return out;
}
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.test("WO-051/E1 off is today: every committed email reads exactly as at the branch point, and the run with the switch off asks nothing and plans exactly what the rules plan", async () => {
  const parts: string[] = [];
  for (const { file, mails } of await committed()) for (const m of mails) parts.push(`${file}/${m.id}:${JSON.stringify(classifyMail({ from: m.from, subject: m.subject, snippet: m.snippet, date: m.date }))}`);
  eq({ n: parts.length, sha256: await sha(parts.join("\n")) }, GOLDEN, "the rules' readings changed");
  assert(/model: Deno\.env\.get\("CAREER_MAIL_MODEL"\) === "on" \? \(\) => mailModelWiring\(Deno\.env, admin\) : undefined/.test(INDEX_SRC), "the switch: only CAREER_MAIL_MODEL=on wires the model");
  for (const { file, mails } of await committed()) {
    const ins: MailIn[] = mails.map((m: any, i: number) => ({ hash: `${file}-${i}`, from: m.from, subject: m.subject, snippet: m.snippet, date: iso(NOW - 60000 + i), auth: AUTH(domainOf(m.from)) }));
    const companies = [...new Set(ins.map((m) => classifyMail(m).company).filter((c): c is string => !!c))];
    const tracker = companies.map((c, i) => ({ app_id: `a${i}`, company: c, stage: "Submitted", applied_at: iso(NOW - 20 * DAY), events: [] }));
    let claims = 0;
    const base = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }], tracker: { U1: tracker } });
    const store = { ...base, claimModelCalls: async () => { claims++; return 0; } };
    const outbox = memoryAlertStore();
    const apps = await base.applications("U1");
    const stats = await runMail({ outbox, now: NOW, store, read: async () => ({ status: "ok", mails: ins, readThrough: NOW, listed: ins.length }) });
    const plan = planUpdates(ins, apps, NOW);
    eq([stats.model, stats.model_calls, claims], [undefined, undefined, 0], `${file}: no model, no claim`);
    eq(base.dump().events.U1 ?? [], plan.events, `${file}: the events are the rules' own`);
    eq(outbox.dump().outbox.filter((o: any) => o.kind === "status").map((o: any) => [o.key, o.text]), plan.texts.map((t) => [t.key, t.text]), `${file}: the texts are the rules' own`);
  }
});

// ------------------------------------------------------------------------------------------------ U: only the unsure
Deno.test("WO-051/U1 only mail the rules are unsure of is asked: a guard's decision and a sure reading never are", async () => {
  eq(UNCERTAIN, { kindSure: 0.8, otherNear: 0.1 });
  const c = (m: MailMeta) => { const x = certainty(m); return `${x.uncertain}:${x.why}`; };
  eq([c(CLEAR_NO), c(SURE_IV), c(VAGUE), c(WEAK_IV), c(WEAK_AS), c(FILLED)], ["false:sure", "false:sure", "true:ambiguous", "true:weak", "true:weak", "true:ambiguous"]);
  eq([c(GOODTIME), c(CALENDAR), c(FWD_SHOWN), c(FWD_BARE)], ["false:guard", "false:guard", "false:guard", "false:guard"], "guards decide; the model is not asked");
  const cold = mailIn("b1", "Dana Park <dana@talentbridge.io>", "Quick question", "Hi Sam, I came across your profile and have an exciting opportunity; open to a quick chat about a role?");
  eq([classifyMail(cold).kind, certainty(cold).uncertain], ["other", false], "a guard after the scorer (cold outreach) is a rule's decision");
  const seen: string[] = [];
  const sp = await secondPass([CLEAR_NO, SURE_IV, VAGUE, WEAK_IV, WEAK_AS, GOODTIME, CALENDAR, FWD_SHOWN], ASANA, async (p: any) => { seen.push(p.messages[0].content.split("\n")[2]); return (await say("none")()); });
  eq(sp.asked, 3, "VAGUE, WEAK_IV and WEAK_AS only");
  eq(seen.length, 3);
  assert(seen.every((s) => !/decided not to move forward|invite you to interview/.test(s)), "the sure ones were never sent");
});

Deno.test("WO-051/U2 how much is sent, per committed split (no label read on a held-out split): under 25% on every read split, 11% over all", () => {
  const want: Record<string, [number, number]> = {
    dev: [31, 23], devcheck: [1, 0], holdout: [5, 5], blind40: [19, 13], dev4: [49, 34], dev4check: [17, 9], blind160: [16, 13], dev5: [34, 25], dev5check: [14, 8],
    blind200: [26, 15], dev6: [28, 14], dev6check: [12, 5], blind240: [39, 21], dev7: [61, 41], dev7check: [24, 11], blind300: [82, 44],
  };
  let total = 0, sent = 0;
  for (const [name, mails] of Object.entries(allSplits())) {
    const s = selection(mails);
    eq([s.uncertain, s.sent], want[name], `${name}: unsure and sent`);
    if (!HELD_OUT.includes(name) && !name.startsWith("blind")) assert(s.fraction_sent < 0.25, `${name}: ${s.fraction_sent}`);
    total += s.total; sent += s.sent;
  }
  eq([total, sent], [2564, 281]);
  assert(sent / total < 0.15, "a small fraction overall");
});

// ------------------------------------------------------------------------------------------------ P: what is sent
const ENV = (more: Record<string, string> = {}) => ({ get: (k: string) => ({ ANTHROPIC_API_KEY: "sk-ant-test-not-real", ...more } as Record<string, string>)[k] });
const fakeOpenAI = (answer: () => string) => fakeAnthropic(() => answer(), { input_tokens: 400, output_tokens: 20 }); // the Anthropic Messages wire
function costSink() {
  const rows: any[] = [];
  return { admin: { from: (t: string) => ({ insert: async (row: any) => { rows.push({ table: t, ...row }); return { error: null }; } }) }, rows };
}

Deno.test("WO-051/P1 what is sent: the sender's display name and domain, the subject and the snippet, masked; never an address, the body, the date or the hash; the strict schema reaches Claude as output_config.format", async () => {
  const m = mailIn("p1", "\"Jo Smith\" <jo.smith@asana.com>", "Re: Account Manager role 4829137", "To: sam.lee@gmail.com. Hi Sam, quick one about your application: call me on 415 555 0199 or write to jo.smith@asana.com.");
  const p = mailModelPayload(m);
  eq(Object.keys(p).sort(), ["max_tokens", "messages", "system"]);
  const lines = (p.messages[0].content as string).split("\n");
  eq(lines.map((l) => l.split(":")[0]), ["From", "Subject", "Snippet"]);
  eq(lines[0], "From: Jo Smith (domain asana.com)", "name and domain only");
  const all = JSON.stringify(p);
  assert(!/jo\.smith@|sam\.lee|4829137|0199/.test(all), all);
  assert(!all.includes(m.date) && !all.includes("\"p1\""), "no date, no hash");
  eq(mailModelPayload({ from: "no-reply@greenhouse.io", subject: "s", snippet: "t" }).messages[0].content.split("\n")[0], "From: (no name) (domain greenhouse.io)");
  assert(/Never the body, an attachment, the date, the message hash or the person's name or address/.test(MODEL_SRC), "said in a comment");
  assert(/never the sender's address, never the person's\s*\n?\/\/\s*own address/.test(MODEL_SRC) || /never the sender's address, never the person's own address/.test(MODEL_SRC), "said in a comment");
  const ai = fakeOpenAI(() => '{"kind":"none","confidence":0.9}');
  const w = mailModelWiring(ENV(), costSink().admin, ai.request);
  assert(w.status === "on");
  await secondPass([VAGUE], ASANA, (payload) => w.deps.call(payload, { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, usd_micros: 0, unpriced: 0, provider: null, models: [] }));
  const body = ai.bodies[0];
  eq([body.output_config?.format?.type, "store" in body, "response_format" in body, ai.onlyAnthropic()], ["json_schema", false, false, true]);
  eq(body.output_config.format.schema, MAIL_VERDICT_FORMAT.json_schema.schema);
  eq(body.output_config.format.schema.properties.kind.enum, ["received", "rejection", "interview", "assessment", "offer", "recruiter_reply", "none"]);
  eq(body.output_config.format.schema.additionalProperties, false);
  assert(!JSON.stringify(body.messages).includes("no-reply@"), "the sender's address never reaches the model");
});

// ------------------------------------------------------------------------------------------------ J: the schema
Deno.test("WO-051/J1 an answer outside the strict schema is ignored: prose around it, another spelling, another kind, a wrong type", async () => {
  for (const text of ['Sure: {"kind":"interview","confidence":0.95}', '{"kind":"Interview","confidence":0.95}', '{"kind":"other","confidence":0.95}', '{"kind":"hired","confidence":0.95}',
    '{"kind":"interview","confidence":"0.95"}', '{"kind":"interview","confidence":1.5}', '[{"kind":"interview","confidence":0.95}]', '{"kind":"interview"}', "interview", ""]) {
    const sp = await secondPass([VAGUE], ASANA, async () => ({ content: [{ type: "text", text }] }));
    eq([sp.decided.size, sp.refused.unreadable], [0, 1], `ignored: ${text}`);
  }
  const ok = await secondPass([VAGUE], ASANA, async () => ({ content: [{ type: "text", text: '{"kind":"interview","confidence":0.95,"note":"x"}' }] }));
  eq([ok.decided.size, ok.decided.get("u1")?.kind, ok.decided.get("u1")?.source], [1, "interview", "model"], "the fixed shape is read; other fields dropped");
});

// ------------------------------------------------------------------------------------------------ S: safety, after the answer
Deno.test("WO-051/S1 a rejection is never turned into an interview, a test, an offer or a reply, whatever the model says", async () => {
  for (const k of ["interview", "assessment", "offer", "recruiter_reply"]) {
    eq(opinion(CLEAR_NO, v(k, 0.99)).why, "rejection_kept", `a rejection the rules read, model ${k}`);
    eq(opinion(FILLED, v(k, 0.99)).why, "rejection_kept", `"the role has been filled", model ${k}`);
    const sp = await secondPass([FILLED], ASANA, say(k, 0.99));
    eq([sp.decided.size, sp.refused.rejection_kept], [0, 1]);
  }
  const no = await secondPass([FILLED], ASANA, say("rejection", 0.99));
  eq(no.decided.get("u4")?.kind, "rejection", "the model may agree it is a rejection");
  const plan = planUpdates([FILLED], ASANA, NOW, no.decided);
  eq([plan.apps[0].stage, plan.events[0]?.flagged, plan.events[0]?.note], ["Submitted", true, "model"], "and that is only said");
  // On the committed splits whose labels may be read: a model that answers "interview" or "offer" to everything never
  // makes a labeled rejection a step forward.
  for (const k of ["interview", "offer"]) {
    for (const [name, mails] of Object.entries(allSplits()).filter(([n]) => !HELD_OUT.includes(n))) {
      const r = await withModel(mails, say(k, 0.99));
      eq([r.rules_and_model.rejection_as_interview, r.rules_and_model.rejection_as_step_forward], [r.rules.rejection_as_interview, r.rules.rejection_as_step_forward], `${name} with a model saying ${k}`);
    }
  }
});

Deno.test("WO-051/S2 a calendar or scheduling tool's notice is never changed by the model: no interview without the interview, the employer and the job", async () => {
  for (const m of [GOODTIME, CALENDAR]) {
    eq(opinion(m, v("interview", 0.99)).why, "calendar", m.subject);
    eq(opinion(m, v("offer", 0.99)).why, "calendar", m.subject);
  }
  const sure = mailIn("g3", "Google Calendar <calendar-notification@google.com>", "Invitation: Interview - Asana - Account Manager @ Tue Oct 21 2pm", "You have been invited to the following event. Interview - Asana - Account Manager.");
  eq([classifyMail(sure).kind, classifyMail(sure).via], ["interview", "calendar"]);
  eq(opinion(sure, v("rejection", 0.99)).why, "calendar", "the rules' reading of a full notice stands too");
  const forced = new Map([[GOODTIME.hash, decidedAs(GOODTIME, "interview", "x")]]);
  eq(planUpdates([GOODTIME], ASANA, NOW, forced).apps[0].stage, "Submitted", "and a scheduling tool's mail never moves a stage anyway");
});

Deno.test("WO-051/S3 a forward counts only through the original sender it shows, and stays evidence", () => {
  eq(opinion(FWD_BARE, v("interview", 0.99)).why, "forward_no_sender");
  const r = opinion(FWD_SHOWN, v("interview", 0.99));
  eq([r.why, r.decided?.kind, r.decided?.via, r.decided?.forwarded_from, r.decided?.company, r.decided?.domain], ["model", "interview", "forward", "no-reply@greenhouse.io", "Asana", "greenhouse.io"]);
  const plan = planUpdates([FWD_SHOWN], ASANA, NOW, new Map([[FWD_SHOWN.hash, r.decided!]]));
  eq([plan.apps[0].stage, plan.texts.length, plan.events.filter((e) => e.stage).length], ["Submitted", 0, 0], "a forward read by the model moves nothing");
});

Deno.test("WO-051/S4 only the employer's own 'received', read by the rules, starts tracking; the model's never does", async () => {
  eq(opinion(VAGUE, v("received", 0.99)).why, "kind_not_allowed");
  const held = opinion(WEAK_IV, v("received", 0.99));
  eq([held.why, held.decided?.kind], ["received_held", "other"], "against a step the rules read, it only holds it back");
  const rec = await secondPass([VAGUE], ASANA, say("received", 0.99));
  eq([rec.decided.size, rec.refused.kind_not_allowed], [0, 1]);
  // No application on file: the model is not even asked, and a model reading never starts one.
  eq(toAsk([VAGUE], []).map((x) => x.why), ["no_application"]);
  for (const k of ["received", "interview", "offer"] as const) {
    const plan = planUpdates([VAGUE], [], NOW, new Map([[VAGUE.hash, decidedAs(VAGUE, k, "x")]]));
    eq([plan.apps.length, plan.texts.length, plan.unmatched], [0, 0, 1], `model ${k} with nothing on file`);
  }
});

Deno.test("WO-051/S5 an offer from the model alone needs the employer's own mail for an application on file, and is only said", async () => {
  const unsigned = { ...VAGUE, hash: "o1", auth: [] };
  const no = await secondPass([unsigned], ASANA, say("offer", 0.99));
  eq([no.decided.size, no.refused.offer_not_employer], [0, 1], "not authenticated as the employer");
  const own = await secondPass([VAGUE], ASANA, say("offer", 0.99));
  eq(own.decided.get("u1")?.kind, "offer");
  const plan = planUpdates([VAGUE], ASANA, NOW, own.decided);
  eq([plan.apps[0].stage, plan.events[0]?.flagged], ["Submitted", true]);
  assert(/may be an offer, but its words don't say so plainly/.test(plan.texts[0]?.text ?? ""), plan.texts[0]?.text);
});

Deno.test("WO-051/S6 'none' and a low confidence: none holds an unsure step back, low confidence leaves the rules' reading", async () => {
  const none = opinion(WEAK_IV, v("none", 0.95));
  eq([none.why, none.decided?.kind, none.decided?.source], ["model_none", "other", "model"]);
  eq(planUpdates([WEAK_IV], ASANA, NOW, new Map([[WEAK_IV.hash, none.decided!]])).apps[0].stage, "Submitted");
  eq(planUpdates([WEAK_IV], ASANA, NOW).apps[0].stage, "Interview rounds", "what the rules alone would do");
  eq(opinion(WEAK_IV, v("rejection", 0.5)).why, "low_confidence");
  eq(opinion(WEAK_IV, v("interview", 0.99)).why, "agrees");
  const as = await secondPass([WEAK_AS], ASANA, say("interview", 0.95));
  eq(as.decided.get("u3")?.kind, "interview", "a different step, from the employer's own mail, may be read");
});

// ------------------------------------------------------------------------------------------------ C: the daily cap
const ATS_MAILS = (n: number, at = NOW - 2 * 60000) => Array.from({ length: n }, (_, i) => ({ ...VAGUE, hash: `d${i}`, date: iso(at + i) }));
function runWith(store: any, mails: MailIn[], at = NOW, answer = () => '{"kind":"none","confidence":0.9}') {
  const ai = fakeOpenAI(answer), costs = costSink(), outbox = memoryAlertStore();
  const run = () => runMail({ outbox, now: at, store, read: async () => ({ status: "ok", mails, readThrough: at, listed: mails.length }), model: mailModelWiring(ENV(), costs.admin, ai.request) });
  return { run, ai, costs };
}
const ASANA_QUEUE = { U1: [{ id: 9, company: "Asana", title: "Account Manager", url: "https://boards.greenhouse.io/asana/jobs/9", state: "confirmed", created_at: iso(NOW - 9 * DAY), updated_at: iso(NOW - 9 * DAY) }] };

Deno.test("WO-051/C1 at most MAIL_MODEL_DAILY_CAP calls a person a day, claimed in the store before any call; a store that cannot count asks nothing", async () => {
  eq(MAIL_MODEL_DAILY_CAP, 200);
  const store = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }], queue: ASANA_QUEUE, model_calls: { "U1|2026-10-20": 195 } });
  const h = runWith(store, ATS_MAILS(MAIL_MODEL_MAX_CALLS));
  const s = await h.run();
  eq([s.model_calls, s.model_capped, h.ai.bodies.length, store.dump().model_calls["U1|2026-10-20"]], [5, 15, 5, 200]);
  const again = runWith(store, ATS_MAILS(3, NOW + 60000), NOW + 120000);
  eq([(await again.run()).model_calls, again.ai.bodies.length], [0, 0], "spent for today");
  eq(await store.claimModelCalls!("U1", 50, 200, NOW + DAY), 50, "a new day starts again");
  eq(await store.claimModelCalls!("U2", 5000, 100000, NOW), 200, "a caller cannot raise the cap");
  const { claimModelCalls: _, ...noCounter } = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }], queue: ASANA_QUEUE });
  const blind = runWith(noCounter, ATS_MAILS(3));
  const b = await blind.run();
  eq([b.model_calls, b.model_capped, blind.ai.bodies.length], [0, 3, 0], "fail closed");
  // The database's own count: the cap is fixed there too, under a per-person lock, for the service role only.
  assert(/least\(greatest\(coalesce\(p_cap, 0\), 0\), 200\)/.test(MIGRATION) && /check \(calls between 0 and 200\)/.test(MIGRATION), "200 in the database");
  assert(/pg_advisory_xact_lock/.test(MIGRATION) && /\(now\(\) at time zone 'utc'\)::date/.test(MIGRATION), "locked, on the database's clock");
  assert(/revoke all on function public\.career_mail_model_claim\(uuid, integer, integer\) from public, anon, authenticated/.test(MIGRATION) && /to service_role;/.test(MIGRATION));
});

Deno.test("WO-051/K1 each person's calls are metered into one agent_turn_costs row", async () => {
  const store = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }], queue: ASANA_QUEUE });
  const h = runWith(store, [WEAK_IV, WEAK_AS, CLEAR_NO], NOW, () => '{"kind":"interview","confidence":0.95}');
  const s = await h.run();
  eq([s.model_calls, s.model_decided, h.ai.bodies.length], [2, 1, 2], "two unsure emails asked; the clear rejection never");
  eq(h.costs.rows.length, 1);
  const c = h.costs.rows[0];
  eq([c.table, c.user_id, c.thread_id, c.provider, c.calls, c.input_tokens, c.output_tokens], ["agent_turn_costs", "U1", null, "anthropic", 2, 800, 40]);
  assert(c.usd_micros > 0, "priced from the gateway's table");
});

// ------------------------------------------------------------------------------------------------ V: the eval, D: the decision
Deno.test("WO-051/V1 the live eval without a key prints NOT_RUN and exits 0; nothing is called", async () => {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-env", "evals/career/mail-model-eval.ts", "--model", "live", "--only", "blind300"],
    cwd: new URL("../../", import.meta.url).pathname, clearEnv: true, env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "/root", DENO_DIR: Deno.env.get("DENO_DIR") ?? "" }, stdout: "piped", stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  eq(out.code, 0, new TextDecoder().decode(out.stderr));
  assert(/^NOT_RUN: no ANTHROPIC_API_KEY/.test(text), text);
  const stub = await withModel(allSplits().dev.slice(0, 40), say("none", 0.9));
  assert(stub.asked >= 1 && stub.rules.predicted >= stub.rules_and_model.predicted, "a model saying none only holds steps back");
});

Deno.test("WO-051/D1 the privacy decision is the owner's: a pending row says what is sent, why, the switch and the cost", () => {
  const row = DECISIONS.split("\n").find((l) => l.startsWith("| D-025 |")) ?? "";
  assert(row, "D-025 is there");
  for (const must of ["CAREER_MAIL_MODEL", "display name and domain", "Never sent:", "the body", "Why:", "Cost (ASSUMED)", "200 calls a person a day", "| pending owner |"]) assert(row.includes(must), `D-025 says: ${must}`);
  assert(!/\|\s*settled/.test(row), "not settled by a builder");
  assert(!/openai|gpt-/i.test(MODEL_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")), "no other provider in the second opinion");
});
