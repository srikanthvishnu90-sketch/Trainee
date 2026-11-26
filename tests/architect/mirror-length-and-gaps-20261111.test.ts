// MIRROR LENGTH AND GAPS (architect builder, 2026-11-11). Two owner asks on the mirror pilot:
//   (a) "Trainee's reply should be the same length" as Instinct's: within +/-10% of Instinct's characters (+/-6 under 60),
//       longer and shorter both miss; scored by evals/mirror/score.ts (length_match, mirror_match) and the tone gate.
//   (b) the router failures #760's dry run left (60 of 443), fixed by cause. The phrasings below are new, not the mirror set's:
//       the fixes read what a message IS (a typed slip of a limit word, a refinement that names no role, a guard beside a
//       hand-off, a request for two lines, a non-English ask), never a prompt.
//   1 empty    an empty list said "No open internships on my list" (never "no open roles") and dropped the stated limits,
//              which typos hid ("remoet", "hybrdi", "potsed in the lasst week")
//   2 refine   "tell me what changed" beside a search change got the tailoring diff; "scratch Atlanta, do Berlin instead" and
//              "cut it down to remote roles" were not read as corrections with a guard riding along; "the start date doesn't
//              matter anymore" was searched for the role "paid"
//   3 handoff  "Don't send anything yet: get that over to Marcus" was a workflow stop
//   4 short    "in two lines" got the full erase and portal explainers
//   5 prep     "I get nervous and ramble" got the night-before plan; a served coding or case question asked for no answer
//   6 language a non-English ask the router claimed from one English keyword was answered in English
// The handler part runs handler-career.ts on Postgres 16 (tests/architect/helpers/response_world.ts) with the staged brain on a
// scripted model ($0; every other host refused and recorded).
import assertNode from "node:assert/strict";
import { lengthMatch, lengthWindow, scorePrompt } from "../../evals/mirror/score.ts";
import { loadSet, SET_PATH } from "../../evals/mirror/distinct.ts";
import { correctionOf, refinedAsk, withoutAsides } from "../../supabase/functions/_shared/search_correction.ts";
import { nonEnglishAsk } from "../../supabase/functions/_shared/ask_language.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const MODEL_LINE = "SCRIPTED: the brain answered this turn.";

Deno.test("a length: the same-length window is +/-10% of Instinct's, +/-6 under 60; longer and shorter both miss", () => {
  assertNode.deepStrictEqual(lengthWindow(200), { min: 180, max: 220 });
  assertNode.deepStrictEqual(lengthWindow(40), { min: 34, max: 46 });
  assertNode.ok(lengthMatch(220, 200) && lengthMatch(180, 200) && !lengthMatch(221, 200) && !lengthMatch(179, 200));
  assertNode.ok(lengthMatch(46, 40) && !lengthMatch(47, 40) && !lengthMatch(33, 40));
});

Deno.test("a mirror_match: same task AND same length AND answers first AND no internal words AND no refusal or action mismatch", async () => {
  const set = await loadSet(SET_PATH);
  const search = set.find((x) => x.category === "search_empty")!;
  const inst = { id: search.id, reply: "No verified roles matched that. I checked the employer boards I can read; nothing was applied for. Want me to widen to the whole state?", actions: [] };
  // About the same length and the same task: a mirror match.
  const same = scorePrompt(search, inst, { id: search.id, reply: "No open roles matched in the places I checked (the employer boards). Nothing was applied for. Should I include nearby cities?", actions: [] });
  assertNode.equal(same.mirror, true);
  assertNode.equal(same.length_match, true, JSON.stringify(same.length));
  assertNode.equal(same.mirror_match, true, same.reasons.join("; "));
  // The same task, much shorter: the old bar passed it, the window does not, so it is not a mirror match.
  const short = scorePrompt(search, inst, { id: search.id, reply: "No open roles matched. Nothing applied for.", actions: [] });
  assertNode.equal(short.mirror, true);
  assertNode.equal(short.length.under, true);
  assertNode.equal(short.mirror_match, false);
  assertNode.ok(short.reasons.some((r) => /^short /.test(r)), short.reasons.join("; "));
  // The same task and length, but internal words: not a mirror match.
  const jargon = scorePrompt(search, inst, { id: search.id, reply: "No open roles matched; the record shows the employer boards were read. Nothing was applied for. Should I include nearby cities?", actions: [] });
  assertNode.equal(jargon.mirror_match, false);
  // One side declines and the other does not: a refusal mismatch.
  const refuse = scorePrompt(search, inst, { id: search.id, reply: "I can't search for that from this chat. No roles were looked up and nothing was applied for. Want to try a different ask?", actions: [] });
  assertNode.equal(refuse.refusal_mismatch, true);
  assertNode.equal(refuse.mirror_match, false);
});

Deno.test("2 refine (unit): a guard and how to answer ride along with a correction; a refinement naming no role keeps the search", () => {
  assertNode.deepStrictEqual(correctionOf("narrow it down to remote jobs (and show me what changed). Just browsing."), { remoteOnly: true });
  assertNode.deepStrictEqual(correctionOf("forget Tampa, try Raleigh instead. Number them so I can pick. Don't apply."), { place: "Raleigh" });
  assertNode.deepStrictEqual(correctionOf("wrong city. I meant Spokane. Nothing submitted."), { place: "Spokane" });
  // Still a whole-message rule: another ask after the correction makes it something else.
  assertNode.equal(correctionOf("remote only, and find me pharmacist jobs too"), null);
  assertNode.equal(withoutAsides("actually Denver, not Chicago"), "actually Denver, not Chicago");
  const d = { lastAsk: { role: "biomedical engineer", place: "Tulsa", remote: false }, lastAskAt: Date.now() };
  assertNode.equal(refinedAsk("the shift times don't matter anymore. Tell me what changed. Don't queue anything.", d)?.role, "biomedical engineer");
  for (const m of ["why isn't Kaiser on that list, only advice", "compare number 2 and number 5, just one line each", "which answers are you missing, short answers only",
    "the level doesn't matter anymore, find data analyst roles", "did anyone reply, only the ones waiting on me"]) assertNode.equal(refinedAsk(m, d), null, m);
  assertNode.equal(refinedAsk("the start date doesn't matter anymore", { lastAsk: d.lastAsk, lastAskAt: Date.now() - 2 * 60 * 60 * 1000 }), null, "an old search is not refined");
  assertNode.equal(refinedAsk("Don't apply: wrong city, I meant Spokane, only paid roles.", d)?.place, "Spokane", "a new place said beside it replaces the old one");
});

Deno.test("6 language (unit): a non-English ask is read as one; English asks, with names and stray words, are not", async () => {
  for (const m of ["Quelles questions dois-je poser à la fin d'un entretien ?", "Pwede mo ba akong tulungan sa resume ko para sa trabaho bilang cashier?",
    "Hola! I need trabajo en Austin, pero no apliques nada todavía", "मुझे दिल्ली में डेटा एनालिस्ट की नौकरी चाहिए", "Szukam pracy jako tester w Krakowie, tylko pokaż oferty"]) assertNode.ok(nonEnglishAsk(m), m);
  for (const m of ["Find data analyst roles in Los Angeles. Don't apply.", "draft a note to Jose de la Cruz at Banco Santander", "per hour, come on, at least $25 an hour in San Diego",
    "what's waiting on me right now?", "I want jobs in La Jolla or Del Mar, remote ok"]) assertNode.ok(!nonEnglishAsk(m), m);
  // The 975 English prompts of the mirror set and their setup turns read as English.
  const set = await loadSet(SET_PATH);
  const english = set.filter((p) => p.category !== "multilingual").flatMap((p) => [p.prompt, ...p.setup.turns]);
  assertNode.deepStrictEqual(english.filter(nonEnglishAsk), []);
});

Deno.test({
  name: "1-6 through the real handler: each cause answers the task, plainly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const skip = canRun();
    if (skip === "FAIL") throw new Error("needs Postgres 16 binaries in CI");
    if (skip) { console.log(`${skip}: mirror length and gaps handler part not run`); return; }
    let modelCalls = 0;
    const scripted = (chat: any) => {
      modelCalls++;
      return Response.json({ id: "mlg", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : MODEL_LINE }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const w = await openWorld(16, { model: (req) => anthropicWire(req, scripted) });
    try {
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const ask = async (m: string, o: { before?: string[]; resume?: boolean } = {}) => {
        const p = await w.person({ resume: o.resume });
        for (const b of o.before ?? []) await p.say(b);
        const calls = modelCalls;
        const r = await p.say(m);
        assertNode.equal(r.status, 200, m);
        return { ...r, reply: String(r.reply ?? ""), model: modelCalls > calls };
      };
      const NO_ROLES = /\b(?:no open roles|found no open roles|none was found)\b/i;

      // 1: an empty list says "no open roles" in plain words and keeps the limits, typed slips and all.
      const e1 = await ask("fnid pharmacy technician jobs, fully remoet, potsed in the lasst week. just loking, dont aply");
      assertNode.ok(!e1.model, "a search is the router's");
      assertNode.match(e1.reply, NO_ROLES, e1.reply);
      assertNode.match(e1.reply, /\bremote\b/i, e1.reply);
      assertNode.match(e1.reply, /\bposted\b/i, e1.reply);
      assertNode.ok(!/submitted|applied to/i.test(e1.reply.replace(/nothing was applied for|haven'?t applied/gi, "")), e1.reply);
      const e2 = await ask("no aplying yt: any inetrnship welding inspector positionns posed recently? hybrdi ok, not fuly onsite");
      assertNode.match(e2.reply, NO_ROLES, e2.reply);
      assertNode.match(e2.reply, /\bhybrid\b/i, e2.reply);

      // 2: "tell me what changed" beside a search change answers about the search, never the tailoring diff.
      const r1 = await ask("forget Tampa, try Raleigh instead. Tell me what changed. Don't apply.", { before: ["Find dental hygienist roles in Tampa. Don't apply to anything."] });
      assertNode.ok(!/No tailoring has run/.test(r1.reply), r1.reply);
      assertNode.match(r1.reply, /Raleigh/, r1.reply);
      const r2 = await ask("narrow it down to remote jobs (and show me what changed). Just browsing.", { before: ["Find copy editor roles in Omaha. Don't apply to anything."] });
      assertNode.ok(!/No tailoring has run/.test(r2.reply), r2.reply);
      assertNode.match(r2.reply, /remote/i, r2.reply);
      const r3 = await ask("the shift times don't matter anymore. Tell me what changed. Don't queue anything.", { before: ["Find dental hygienist roles in Tampa. Don't apply to anything."] });
      assertNode.match(r3.reply, /dental hygienist/i, `the role of the last search is kept: ${r3.reply}`);
      assertNode.match(r3.reply, /\bkept\b/i, r3.reply);

      // 3: a guard beside a hand-off to a named person is not a stop; nothing is claimed sent.
      const h = await ask("Don't send anything yet: get this over to Priyanka, about the TEST internship.");
      assertNode.ok(!/people list was being built|Outreach drafts on record/.test(h.reply), h.reply);
      assertNode.ok(!/\b(?:sent|emailed) (?:it|this|your)/i.test(h.reply), h.reply);

      // 4: "in two lines" gets the two lines, and the safety words stay.
      const er = await ask("Hypothetically, how would I delete all my data? Keep it to two lines.");
      assertNode.ok(er.reply.length <= 400, er.reply);
      assertNode.match(er.reply, /yes, erase it/, er.reply);
      assertNode.ok(!/\b(?:deleted|erased) (?:everything|your)\b/i.test(er.reply), er.reply);
      const pa = await ask("how do employer sites that need an account work with you? short answer please.");
      assertNode.ok(pa.reply.length <= 400, pa.reply);
      assertNode.match(pa.reply, /never sign in|sign in to/i, pa.reply);

      // 5: nerves alone are not the night before; a served coding or case question asks for the answer.
      const n = await ask("what will they ask in a data engineer interview at Microsoft? I get anxious and talk too fast.");
      assertNode.ok(!/plan for tonight/.test(n.reply), n.reply);
      const night = await ask("I have an interview tomorrow and I'm nervous");
      assertNode.match(night.reply, /plan for tonight/, "the night before still gets the plan");
      const cq = await ask("quiz me like an Amazon coding interviewer. It's a phone screen.");
      if (/coding question|case/i.test(cq.reply)) assertNode.match(cq.reply, /\?\s*$/, cq.reply);

      // 6: a non-English ask is the brain's turn, which answers in the person's language.
      const fr = await ask("Quelles questions dois-je poser à la fin d'un entretien ?");
      assertNode.ok(fr.model, `the brain answers it: ${fr.reply}`);
      const es = await ask("Hola! I need trabajo en Austin, pero no apliques nada todavía");
      assertNode.ok(es.model, `the brain answers it: ${es.reply}`);

      assertNode.deepStrictEqual(w.outbound, [], "no request left but the database double and the scripted model");
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("CAREER_BRAIN");
      await w.close();
    }
  },
});
