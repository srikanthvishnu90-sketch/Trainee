// DT-1: the mass-apply outcome eval's own tests. Run with read permission only (no network, no subprocess, no env), which
// is itself the proof that the deterministic mode calls no model and reaches no site:
//   deno test --allow-read --no-check evals/career/mass-apply-outcomes/outcomes.test.ts
import { accepts, expectFor, HERE, loadInputs, norm, type Persona, type Posting, prepare, runAll, score, shownValue, validateGold, variantsOf } from "./harness.ts";
import { CLAUDE_ARGS, childEnv, readStream, settingsRefusal } from "./judge.ts";

function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
function ok(v: unknown, m = "") { if (!v) throw new Error(m || "expected true"); }

const P: Persona = { name: "TEST", resume_sha256: "c".repeat(64), confirmed: { full_name: "Test Person", email: "test.person@example.test", phone: "+1 555 010 0000", sponsorship: "No", resume: "@resume" } };
const f = (label: string, o: Partial<{ required: boolean; type: string; options: string[] | { label: string; value: string }[] }> = {}) => ({
  name: label.toLowerCase().replace(/\W+/g, "_"), label, required: o.required ?? true, type: o.type ?? "text",
  options: (o.options ?? []).map((x: any) => typeof x === "string" ? { label: x, value: x } : x),
});

Deno.test("gold: every field of every posting is labeled, every accepted option exists, every $fact is confirmed", () => {
  const { postings, personas } = loadInputs();
  eq(validateGold(postings, personas), []);
  eq(new Set(postings.map((p) => p.posting.family)), new Set(["greenhouse", "lever", "ashby"]));
  for (const fam of ["greenhouse", "lever", "ashby"]) eq(postings.filter((p) => p.posting.family === fam).length, 8, fam);
});

Deno.test("gold: a label that names a fact the person never confirmed is a gold error, not a pass", () => {
  const posting = { id: "T", family: "lever", company: "TEST", source_url: "https://jobs.lever.co/test/x", fields: [f("LinkedIn")] } as Posting;
  const errs = validateGold([{ posting, labels: { "0": "fill:$linkedin" } }], { A: P });
  ok(errs.some((e) => /has not confirmed/.test(e)), JSON.stringify(errs));
});

Deno.test("grader: option prefixes, yes/no boxes, phone numbers, the resume and shared option values", () => {
  const sel = f("Sponsorship?", { options: [{ label: "Yes, I will require it", value: "1" }, { label: "No, I do not require it", value: "0" }] });
  eq(shownValue(sel, "0", P), { text: "No, I do not require it", unverifiable: false });
  ok(accepts(sel, "No, I do not require it", ["No*"], P));
  ok(!accepts(sel, "Yes, I will require it", ["No*"], P));
  const box = f("Will you need sponsorship?", { type: "checkbox" });
  ok(accepts(box, "false", ["No"], P) && accepts(box, "no", ["No"], P) && !accepts(box, "yes", ["No"], P));
  ok(accepts(f("Phone"), "(555) 010-0000", ["$phone"], P), "the same national number");
  ok(!accepts(f("Phone"), "+1 555 010 0001", ["$phone"], P));
  eq(shownValue(f("Resume", { type: "file" }), P.resume_sha256, P).text, "@resume");
  const radio = f("Male", { type: "radio", options: [{ label: "Male", value: "on" }, { label: "Decline to self-identify", value: "on" }] });
  eq(shownValue(radio, "on", P), { text: null, unverifiable: true });
  eq(norm("  I am a “U.S. Person”. "), 'i am a "u.s. person"');
  // A multi-select: every part picked must be accepted; an option whose own label has a comma is one part.
  const langs = f("Languages you speak fluently", { type: "multi_value_multi_select", options: [{ label: "English", value: "11" }, { label: "Hindi", value: "12" }, { label: "Spanish", value: "13" }, { label: "Hispanic, Latino, or Spanish origin", value: "14" }] });
  eq(shownValue(langs, "11,12", P).text, "English, Hindi");
  ok(accepts(langs, "English, Hindi", ["English", "Hindi"], P), "both languages the person confirmed");
  ok(!accepts(langs, "English, Spanish", ["English", "Hindi"], P), "a language the person never confirmed is wrong");
  ok(accepts(langs, "Hispanic, Latino, or Spanish origin", ["Hispanic, Latino, or Spanish origin"], P));
});

Deno.test("grader: a fill on a question no confirmed fact answers is WRONG; an answerable question asked is unneeded", () => {
  const posting: Posting = { id: "T-1", family: "greenhouse", company: "TEST Co", source_url: "https://job-boards.greenhouse.io/test/jobs/1",
    fields: [f("Email"), f("Full name"), f("Why do you want to work here?", { type: "textarea" })] };
  // Gold says the email must NOT be filled (a deliberately wrong label): the planner fills it, so the grader must call it wrong.
  const r = prepare(posting, { "0": "ask", "1": "fill:$full_name", "2": "fill:TEST essay" }, P, "A", Date.UTC(2026, 10, 5));
  eq(r.fields.map((x) => x.verdict), ["wrong", "correct_fill", "unneeded_ask"]);
  eq(r.state, "over_held", "held only by a question gold says a confirmed fact answers");
  const contested = prepare(posting, { "0": { e: "ask", contested: true }, "1": "fill:$full_name", "2": "ask" }, P, "A", Date.UTC(2026, 10, 5));
  eq(contested.fields.map((x) => x.verdict), ["contested_fill", "correct_fill", "correct_ask"]);
  eq(contested.state, "held");
});

Deno.test("grader: ready with a required question nobody can answer is unsafe; held only by answerable questions is over-held", () => {
  const posting: Posting = { id: "T-2", family: "lever", company: "TEST Co", source_url: "https://jobs.lever.co/test/00000000-0000-4000-8000-000000000002",
    fields: [f("Full name"), f("Email")] };
  eq(prepare(posting, { "0": "fill:$full_name", "1": "ask" }, P, "A", 0).state, "unsafe_ready");
  eq(prepare(posting, { "0": "fill:$full_name", "1": "fill:$email" }, P, "A", 0).state, "ready");
});

Deno.test("expectations: per-person labels, knockout and contested flags", () => {
  eq(expectFor({ A: "fill:No", B: "fill:Yes", ko: true }, "B"), { kind: "fill", accept: ["Yes"], ko: true, contested: false });
  eq(expectFor("either:Decline to self-identify", "A").kind, "either");
  let threw = false; try { expectFor("guess:Yes", "A"); } catch { threw = true; }
  ok(threw, "an unknown expectation kind is refused");
});

Deno.test("duplicates: link variants are built from the posting's own board and job id", () => {
  const gh = { id: "g", family: "greenhouse", company: "X", source_url: "https://job-boards.greenhouse.io/stripe/jobs/8172510", fields: [] } as Posting;
  eq(variantsOf(gh, [{ id: "v", url: "https://boards.greenhouse.io/{board}/jobs/{jid}" }])[0].url, "https://boards.greenhouse.io/stripe/jobs/8172510");
  const lv = { id: "l", family: "lever", company: "X", source_url: "https://jobs.lever.co/veeva/9ac55b31-df46-4acb-b305-2c0b7ed56027/apply", fields: [] } as Posting;
  eq(variantsOf(lv, [{ id: "v", url: "https://jobs.lever.co/{board}/{jid}/" }])[0].url, "https://jobs.lever.co/veeva/9ac55b31-df46-4acb-b305-2c0b7ed56027/");
});

Deno.test("the run is deterministic and never worse than the committed baseline (a ratchet, not a frozen snapshot)", async () => {
  const one = await runAll(), two = await runAll();
  eq(JSON.stringify(one), JSON.stringify(two), "two runs differ");
  const s = score(one.apps, one.failures);
  const base = JSON.parse(Deno.readTextFileSync(new URL("results/baseline.json", HERE))).scorecard;
  ok(s.overall.wrong_answers <= base.overall.wrong_answers, `wrong answers rose: ${s.overall.wrong_answers} > ${base.overall.wrong_answers}`);
  ok(s.overall.unsafe_ready <= base.overall.unsafe_ready, "an application became ready with an unanswerable required question");
  ok(s.overall.unverifiable_answers <= base.overall.unverifiable_answers, "more unidentifiable answers");
  ok(s.overall.required_silent_gaps <= base.overall.required_silent_gaps, "more required fields neither filled nor asked");
  ok(s.overall.fills_correct >= base.overall.fills_correct, `correct fills fell: ${s.overall.fills_correct} < ${base.overall.fills_correct}`);
  ok(s.overall.preparable_after_answers >= base.overall.preparable_after_answers, `fewer applications preparable: ${s.overall.preparable_after_answers} < ${base.overall.preparable_after_answers}`);
  ok(s.overall.questions_answerable_from_facts <= base.overall.questions_answerable_from_facts, "more questions asked that confirmed facts answer");
  ok(s.overall.contested_fills <= base.overall.contested_fills, "more contested fills");
  // Each downstream check: no more failures AND no fewer applications reaching it (a regression that makes applications
  // unpreparable shrinks the denominator; it must not pass by doing so).
  for (const k of ["prepared_state", "hash_honoured", "changed_not_queued", "stale_hash_refused", "duplicates_refused", "other_role_admitted", "submitted_state", "resend_guard", "receipt_truthful", "proof", "proof_receipt"]) {
    const now = s.overall[k as keyof typeof s.overall] as any, was = base.overall[k];
    ok(now.of >= was.of, `${k}: only ${now.of} applications reached it, baseline ${was.of}`);
    ok(now.of - now.ok <= was.of - was.ok, `${k}: ${now.of - now.ok} failing, baseline ${was.of - was.ok}`);
    ok(now.ok >= was.ok, `${k}: ${now.ok} passing, baseline ${was.ok}`);
  }
  eq(s.cards.every((c: any) => c.ok === c.steps), true, "a card reply approved a different set than named");
});

Deno.test("committed SCORECARD.md and baseline agree", () => {
  const md = Deno.readTextFileSync(new URL("results/SCORECARD.md", HERE));
  const base = JSON.parse(Deno.readTextFileSync(new URL("results/baseline.json", HERE)));
  ok(md.includes(`**Verdict: ${base.scorecard.verdict}**`), "the scorecard's verdict is the baseline's");
  ok(md.includes(`**${base.scorecard.overall.wrong_answers}** |`), "the scorecard's wrong-answer count is the baseline's");
});

Deno.test("judge (off by default): the claude CLI child never sees an API key, and a non-subscription run is refused", async () => {
  const env = childEnv({ PATH: "/usr/bin", HOME: "/tmp", ANTHROPIC_API_KEY: "TEST-not-a-key", ANTHROPIC_AUTH_TOKEN: "TEST-not-a-token" });
  eq(Object.keys(env).sort(), ["HOME", "PATH"]);
  ok(CLAUDE_ARGS.includes("--strict-mcp-config") && CLAUDE_ARGS.includes("haiku") && !CLAUDE_ARGS.includes("--bare"));
  const line = (o: unknown) => JSON.stringify(o);
  let refused = false;
  try { readStream([line({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }), line({ type: "result", result: "{}" })].join("\n")); } catch { refused = true; }
  ok(refused, "an API-key-billed run must be refused");
  eq(readStream([line({ type: "system", subtype: "init", apiKeySource: "none" }), line({ type: "result", result: '{"verdict":"correct"}' })].join("\n")).text, '{"verdict":"correct"}');
  // The deterministic path never loads the judge: run.ts imports it only behind --judge, and the harness spawns nothing.
  const harness = await Deno.readTextFile(new URL("harness.ts", HERE));
  ok(!/from\s+["'][^"']*judge\.ts|import\(|Deno\.Command|\bfetch\(/.test(harness), "the harness must not reach a model or the network");
  const run = await Deno.readTextFile(new URL("run.ts", HERE));
  ok(/if \(flag\("--judge"\)\)[\s\S]*await import\("\.\/judge\.ts"\)/.test(run) && !/^import .*judge/m.test(run), "the judge is a lazy import behind --judge");
});

Deno.test("judge preflight: a CLI settings file that supplies a key or a key helper stops the judge before any call", () => {
  eq(settingsRefusal({ "/h/.claude/settings.json": '{"theme":"dark"}', "/h/.claude.json": '{"oauthAccount":{"emailAddress":"x@example.test"}}' }), null);
  ok(/apiKeyHelper/.test(settingsRefusal({ "/h/.claude/settings.json": '{"apiKeyHelper":"/bin/echo TEST"}' }) ?? ""));
  ok(/ANTHROPIC_API_KEY/.test(settingsRefusal({ "/p/.claude/settings.local.json": '{"env":{"ANTHROPIC_API_KEY":"TEST"}}' }) ?? ""));
  ok(/ANTHROPIC_AUTH_TOKEN/.test(settingsRefusal({ "/p/.claude/settings.json": '{"env":{"ANTHROPIC_AUTH_TOKEN":"TEST"}}' }) ?? ""));
  ok(/primaryApiKey/.test(settingsRefusal({ "/h/.claude.json": '{"primaryApiKey":"TEST"}' }) ?? ""));
  ok(/unreadable/.test(settingsRefusal({ "/h/.claude/settings.json": "{not json" }) ?? ""), "a settings file that cannot be read fails closed");
});
