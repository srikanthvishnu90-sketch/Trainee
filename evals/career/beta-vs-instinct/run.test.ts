// The benchmark's own tests: the case file is well formed, and the scoring rules score the beta's real replies the way
// the evidence report did. No database, no model, no network.
//   deno test -A --no-check evals/career/beta-vs-instinct/run.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buckets, type Case, CLI_ARGS, cliEnv, hasDraftText, negationHit, proxy, questionCount, type Rec, recDeliverable, recGuards, scoreDet, searchLeak, SCRIPTED, subscriptionGate } from "./score.ts";
import { DIMENSIONS, jsonOf, refItemPrompt, relative } from "./opus.ts";

const HERE = new URL(".", import.meta.url).pathname;
const SPEC = JSON.parse(await Deno.readTextFile(`${HERE}cases.json`));
const CASES: Case[] = SPEC.cases;
const byId = new Map(CASES.map((c) => [c.id, c]));
const KINDS = new Set(Object.keys(SPEC.criteria_kinds));

function rec(over: Partial<Rec>): Rec {
  return { case: "X", state: "empty", input: "", status: 200, reply: "", intent: null, result_status: null, contained: false, brain: null, router_intent: null, layer: "router", handler: "", router_ms: 0, router_calls: 1, turn_ms: 0, cpu_ms: 0, model_calls: 0, brain_tools: [], file_tool_offered: false, files: [], roles: 0, links: 0, writes: {}, profile_changed: false, outbound: [], meta_keys: [], criteria: {}, pass: null, bucket: [], ...over };
}
function scoreAll(cs: Case, r: Rec, body: any = {}) {
  for (const c of cs.criteria.filter((c) => !c.when || c.when === r.state)) { const s = scoreDet(c, r, body); r.criteria[c.id] = { ...s, kind: c.k === "judge" ? "judge-proxy" : c.k }; }
  if (!r.criteria.no_effect) r.criteria.no_effect = { ...scoreDet({ id: "no_effect", k: "no_effect" }, r, body), kind: "no_effect" };
  return r;
}

Deno.test("cases.json: the 104 beta inputs, C01-C04 and A1.1-A25.4, each once", () => {
  assertEquals(CASES.length, 104);
  assertEquals(new Set(CASES.map((c) => c.id)).size, 104);
  for (const id of ["C01", "C02", "C03", "C04"]) assert(byId.has(id), id);
  for (let f = 1; f <= 25; f++) for (let i = 1; i <= 4; i++) assert(byId.has(`A${f}.${i}`), `A${f}.${i}`);
  for (const c of CASES) assert(SPEC.features[c.feature], `${c.id} feature ${c.feature}`);
});

Deno.test("cases.json: every criterion is a known kind, every regex compiles, every judge criterion has a proxy", () => {
  for (const c of CASES) {
    assert(c.criteria.some((k) => k.k === "not_generic"), `${c.id} has no not_generic`);
    for (const k of c.criteria) {
      assert(KINDS.has(k.k), `${c.id}/${k.id} kind ${k.k}`);
      for (const re of [k.re, k.det, k.det_not]) if (re !== undefined) new RegExp(re, "gi");
      if (k.k === "judge") { assert(k.q, `${c.id}/${k.id} has no question`); assert(k.det !== undefined || k.det_not !== undefined || k.det_words_max !== undefined, `${c.id}/${k.id} has no proxy`); }
    }
  }
});

Deno.test("cases.json: a thread's earlier turns are earlier cases; Instinct verdicts name real criteria", () => {
  for (const c of CASES) {
    for (const a of c.after ?? []) assert(byId.has(a) && CASES.indexOf(byId.get(a)!) < CASES.indexOf(c), `${c.id} after ${a}`);
    if (c.instinct) for (const v of Object.keys(c.instinct.verdicts)) assert(c.criteria.some((k) => k.id === v), `${c.id} instinct verdict ${v}`);
  }
  assertEquals(CASES.filter((c) => c.instinct).map((c) => c.id), ["C01", "C02", "C03", "C04"]);
});

// The replies below are the trunk replies the benchmark recorded at 7aea15e (and the beta report's live text).
const C01_REPLY = "I found no posting for three realistic entry-level customer support send links do contact anyone in Chicago (entry level): the live board has no match for it, and the saved snapshot has none either. Nothing was invented to fill the list. Widen the role or the place and I'll search again.";
const C04_REPLY = "The counter email, written out — the real words, held for your approval.\nThe counter email itself, composed from your offer record — held on its card, nothing sent: Subject: Offer — the firm Dear the firm team, Thank you for the offer — $24 an hour. It asks for $24 an hour — the ask is your figure, in your units, never converted to an annual number. Approve it as written, or tell me the figure or the tone to change.";

Deno.test("C01: no links is a failed deliverable, and the constraint words in the searched role are caught", () => {
  const r = scoreAll(byId.get("C01")!, rec({ case: "C01", input: byId.get("C01")!.input, reply: C01_REPLY, intent: "career_discovery" }));
  assertEquals(r.criteria.links3.pass, false);
  assertEquals(r.criteria.honest_links.pass, false);
  assertEquals(recDeliverable(r), false);
  assert(recGuards(r));
  assert(/three/.test(searchLeak(C01_REPLY)!) && /contact/.test(searchLeak(C01_REPLY)!));
  r.pass = false;
  assert(buckets(r, byId.get("C01")!).includes("search_query_polluted_by_count_or_constraint_words"));
  assertEquals(searchLeak("I found no posting for customer support in Chicago: the live board has no match."), null);
});

Deno.test("C02: the negated 'do not apply' reading is a negation bucket, not a pass", () => {
  assert(negationHit(byId.get("C02")!.input, "career_application_fields"));
  assert(!negationHit("What fields do application forms usually ask for?", "career_application_fields"));
  const r = scoreAll(byId.get("C02")!, rec({ case: "C02", input: byId.get("C02")!.input, reply: "What application forms usually ask for. Most forms ask for name, resume ...", intent: "career_application_fields" }));
  assertEquals(r.criteria.not_fields.pass, false);
  assertEquals(r.criteria.roles.pass, false);
});

Deno.test("C04: the held $24 'the firm' draft counts as a draft but fails asks-more, no-placeholder and the direct answer", () => {
  assert(hasDraftText(C04_REPLY), "an inline Subject: is a draft");
  const r = scoreAll(byId.get("C04")!, rec({ case: "C04", reply: C04_REPLY, intent: "negotiation_draft" }));
  assertEquals(r.criteria.draft.pass, true);
  assertEquals(r.criteria.asks_more.pass, false);
  assertEquals(r.criteria.no_placeholder.pass, false);
  assertEquals(r.criteria.answers.pass, false);
  const good = "Yes, counter: $24 is at the low end for Chicago support roles.\nSubject: Customer Support Specialist offer\nHi Dana,\nThank you for the offer. Could we do $26/hour, and could you share the benefits and schedule?\nThanks,\nAlex";
  const g = scoreAll(byId.get("C04")!, rec({ case: "C04", reply: good, intent: "negotiation_draft" }));
  for (const k of ["draft", "asks_more", "no_placeholder", "answers"]) assertEquals(g.criteria[k].pass, true, k);
});

Deno.test("C03: one practice question and no File fail; five questions and a timed plan pass the proxies", () => {
  const cs = byId.get("C03")!;
  const r = scoreAll(cs, rec({ case: "C03", reply: "Your interview brief. Likely first questions: Tell me about yourself and why this role. · Want to run it as a mock?" }));
  assertEquals(r.criteria.file.pass, false);
  assertEquals(r.criteria.five_q.pass, false);
  assertEquals(r.criteria.plan30.pass, false);
  const ok = "FILE: prep\n1. Why support?\n2. Tell me about an upset customer you calmed down?\n3. How do you handle a queue spike?\n4. What does good service mean to you?\n5. What questions do you have for us?\nPlan: 10 min stories, 10 min questions out loud, 5 min company, 5 min logistics.";
  const g = scoreAll(cs, rec({ case: "C03", reply: ok, files: ["prep"] }));
  for (const k of ["file", "five_q", "plan30", "one_page"]) assertEquals(g.criteria[k].pass, true, k);
});

Deno.test("a File's content counts: labelled questions and its own length", () => {
  const file = "Interview prep\n5 practice questions:\nQuestion 1: Tell me about yourself.\nQuestion 2: A hard customer.\nQuestion 3: A queue spike.\nQuestion 4: Learning fast.\nQuestion 5: Why us.\nMinute 0 to 3 (3 min): read\nMinute 3 to 19 (16 min): answer\nMinute 19 to 30 (11 min): logistics";
  assertEquals(questionCount(file), 5);
  const cs = byId.get("C03")!;
  const r = scoreAll(cs, rec({ case: "C03", reply: "Your one-page interview prep File: 5 questions and a 30-minute plan.\nhttps://trainee.test/file?t=x", files: ["plan_review:prep"] }), { __fileText: file });
  for (const k of ["file", "five_q", "plan30", "one_page"]) assertEquals(r.criteria[k].pass, true, k);
});

Deno.test("guards: bookkeeping writes are not account writes; a real watch row is", () => {
  const book = { agent_flow_state: [0, 1], agent_rate_limits: [0, 1], agent_threads: [0, 1], agent_turn_costs: [0, 1], career_watch_kv: [1, 2], "kv:career:account": [1, 2], "kv:career:turn:a:b": [0, 3] } as Record<string, [number, number]>;
  assertEquals(scoreDet({ id: "w", k: "no_write" }, rec({ writes: book }), {}).pass, true);
  assertEquals(scoreDet({ id: "w", k: "no_write" }, rec({ writes: { ...book, career_watch_profiles: [0, 1] } }), {}).pass, false);
  assertEquals(scoreDet({ id: "w", k: "no_write" }, rec({ writes: { ...book, "kv:career:watch": [0, 9] } }), {}).pass, false);
  assertEquals(scoreDet({ id: "e", k: "no_effect" }, rec({ writes: { career_send_queue: [0, 1] } }), {}).pass, false);
  assertEquals(scoreDet({ id: "e", k: "no_effect" }, rec({ outbound: ["POST api.example.com/x"] }), {}).pass, false);
});

Deno.test("scripted brain: content criteria are unmeasured, the record is unverified (not a pass), guards still count", () => {
  const cs = byId.get("A12.1")!;
  const r = scoreAll(cs, rec({ case: "A12.1", reply: SCRIPTED, layer: "staged_brain", brain: "staged" }));
  assertEquals(r.criteria.draft.pass, null);
  assertEquals(r.criteria.generic.pass, null, "the scripted marker is not a measured answer");
  assertEquals(recDeliverable(r), null);
  // A brain record whose only checks are not_generic / not_mentions (A18.3, A18.4 shape) is unverified, never delivered.
  const thin = scoreAll(byId.get("A18.3")!, rec({ case: "A18.3", reply: SCRIPTED, layer: "staged_brain", brain: "staged" }));
  assertEquals(recDeliverable(thin), null);
  const neg = scoreAll(byId.get("A6.2")!, rec({ case: "A6.2", reply: SCRIPTED, layer: "staged_brain", brain: "staged" }));
  assertEquals(neg.criteria.on_topic.pass, null);
  assert(recGuards(r));
});

Deno.test("generic fallback text fails every proxy", () => {
  const v = proxy({ id: "x", k: "judge", det: "\\S" }, "I'm Trainee, a career agent: I find roles, prepare and track your applications.");
  assertEquals(v?.pass, false);
});

Deno.test("Claude CLI: subscription only (both API variables removed) and the exact headless command", () => {
  const e = cliEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin", HOME: "/h" });
  assertEquals(e.ANTHROPIC_API_KEY, undefined);
  assertEquals(e.ANTHROPIC_AUTH_TOKEN, undefined);
  assertEquals(e.PATH, "/bin");
  assertEquals(CLI_ARGS("opus"), ["-p", "--model", "opus", "--output-format", "json", "--tools", "", "--strict-mcp-config"]);
  const src = Deno.readTextFileSync(`${HERE}opus.ts`) + Deno.readTextFileSync(`${HERE}run.ts`);
  assert(!/x-api-key|api\.anthropic\.com\/v1\/messages|new Anthropic\(/.test(src.replace(/hostname === "api\.anthropic\.com"/g, "")), "no direct API call");
  assert(/clearEnv: true/.test(src));
});

Deno.test("subscription gate: every CLI path checks apiKeySource is none before its first call, and stops otherwise", async () => {
  await subscriptionGate(async () => "none");
  for (const bad of ["ANTHROPIC_API_KEY", "unknown", ""]) {
    let threw = false;
    try { await subscriptionGate(async () => bad); } catch (e) { threw = /STOP/.test((e as Error).message); }
    assert(threw, `gate must stop on apiKeySource=${bad}`);
  }
  const run = Deno.readTextFileSync(`${HERE}run.ts`), opus = Deno.readTextFileSync(`${HERE}opus.ts`);
  // run.ts --judge: the gate sits at the top of claudeJudge, before the CLI is spawned, and there is no retry loop.
  const j = run.slice(run.indexOf("async function claudeJudge"));
  assert(j.indexOf("subscriptionGate(verifySubscription)") >= 0 && j.indexOf("subscriptionGate(verifySubscription)") < j.indexOf("new Deno.Command"), "run.ts gates before spawning");
  assert(!/for \(let a = 0; a < 2/.test(run), "no judge retry loop");
  // opus.ts: guard() runs the gate and is awaited before every batch's cli() call.
  assert(/subscriptionGate\(/.test(opus));
  for (const m of opus.matchAll(/await guard\(\);\s*\n\s*calls\+\+;\s*\n[^\n]*\n\s*const r = await cli\(/g)) assert(m);
  assertEquals([...opus.matchAll(/await guard\(\);/g)].length, 2, "both the reference and the judge batches are gated");
});

Deno.test("Opus arm: verdicts are mapped to Trainee-relative win/tie/loss by position; history reaches the prompt", () => {
  assertEquals(relative("A", true), "win");
  assertEquals(relative("B", true), "loss");
  assertEquals(relative("A", false), "loss");
  assertEquals(relative("B", false), "win");
  assertEquals(relative("tie", false), "tie");
  assertEquals(relative(undefined, true), "missing");
  assertEquals(DIMENSIONS.map(([d]) => d), ["ask", "delivered", "correct", "texting", "next"]);
  assertEquals(jsonOf('noise {"replies":[{"id":"a","reply":"b"}]} tail').replies[0].reply, "b");
  const p = refItemPrompt(byId.get("A7.3")!, "empty", [{ user: "Draft a 100-word why this role answer", assistant: "Which role is it for?" }]);
  assert(p.includes("Which role is it for?") && p.includes("Shorten that answer to 50 words"));
});

Deno.test("committed caches carry no secret-shaped strings", () => {
  for (const f of ["opus-refs.json", "pairwise-cache.json"]) {
    let t = "";
    try { t = Deno.readTextFileSync(`${HERE}${f}`); } catch { continue; }
    assert(!/sk-ant-|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|eyJhbGciOi/.test(t), f);
  }
});
