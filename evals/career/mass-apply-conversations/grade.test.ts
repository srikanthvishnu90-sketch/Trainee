// The grader's own tests: each check reads what it says it reads, and the score follows the rubric's rule. $0, no database.
import { assertEquals } from "jsr:@std/assert@1";
import { cardItems, cardsBefore, FNS, type Scenario, score, type Snapshot } from "./grade.ts";

const card = "3 applications are ready. Every answer below goes exactly as shown.\n\n1. Lumen — Data Analyst\n   Resume: A.pdf\n   Sends to https://boards.greenhouse.io/lumen/jobs/801\n\n2. Orbit\n   Email: a@x.test\n\n3. Kite — Data Science Intern\n   Fits: your Python\n\nReply \"yes\" to send all 3.";
const base = (o: Partial<Snapshot> = {}): Snapshot => ({
  said: ["apply to x", "yes"], replies: ["3/3 queued", "3 approved exactly as shown."], intents: ["career_apply_queue", "career_apply_card_answer"], turnMs: [10, 10], scripted: [0, 1],
  thread: [{ content: "3/3 queued", meta: { intent: "career_apply_queue" } }, { content: card, meta: { intent: "career_apply_card", card_id: "c1" } }, { content: "3 approved exactly as shown.", meta: { intent: "career_apply_card_answer" } }],
  atsPosts: [], postsAt: [0, 0], jobsAt: [0, 3], wallMs: [100, 100], requested: [], wanted: [], jobs: [], questions: [], ...o,
});
const S: Scenario = { id: "T", title: "t", setup: [], turns: ["apply to x", "yes"], oracle: {}, ten: "", checks: [] };
const job = (company: string, h = "h1") => ({ company, url: `https://x/${company}`, job_id: `gh:${company}`, payload_hash: h, approval_hash: h, payload_hash_now: h, state: "submitted_unconfirmed", confirmation_id: null });

Deno.test("cards are found before a turn and their items read", () => {
  const x = base(), c = cardsBefore(x, 1);
  assertEquals(c.length, 1);
  assertEquals(cardItems(c[0]).map((i) => i.n), [1, 2, 3]);
});
Deno.test("card_fields: role and link are read per item", () => {
  const p = [{ job_id: "a", company: "Lumen", title: "Data Analyst", location: "", url: "", description: "" }, { job_id: "b", company: "Orbit", title: "Data Analyst Intern", location: "", url: "", description: "" }, { job_id: "c", company: "Kite", title: "Data Science Intern", location: "", url: "", description: "" }];
  assertEquals(FNS.card_fields(base(), { fields: ["role"] }, S, p)[0], false); // Orbit has no role
  assertEquals(FNS.card_fields(base(), { fields: ["link"] }, S, p)[1], "missing #2 link, #3 link");
});
Deno.test("nothing_before reads the turn before the yes", () => {
  assertEquals(FNS.nothing_before(base(), { turn: 1 }, S, [])[0], true);
  assertEquals(FNS.nothing_before(base({ postsAt: [1, 1] }), { turn: 1 }, S, [])[0], false);
});
Deno.test("hash_bound and exactly_once", () => {
  const x = base({ jobs: [job("Lumen"), job("Kite")], atsPosts: [{ board: "lumen", job: "801", files: [], fields: {}, confirmation_id: "x" }, { board: "kite", job: "702", files: [], fields: {}, confirmation_id: "y" }] });
  assertEquals(FNS.hash_bound(x, {}, S, [])[0], true);
  assertEquals(FNS.exactly_once(x, {}, S, [])[0], true);
  assertEquals(FNS.hash_bound(base({ jobs: [{ ...job("Lumen"), payload_hash_now: "other" }] }), {}, S, [])[0], false);
  assertEquals(FNS.exactly_once(base({ jobs: [job("Lumen")], atsPosts: [{ board: "lumen", job: "801", files: [], fields: {}, confirmation_id: "x" }, { board: "lumen", job: "801", files: [], fields: {}, confirmation_id: "z" }] }), {}, S, [])[0], false);
});
Deno.test("approved_card_items: the companies at those card numbers", () => {
  const x = base({ jobs: [job("Lumen"), job("Kite")] });
  assertEquals(FNS.approved_card_items(x, { items: [1, 3] }, S, [])[0], true);
  assertEquals(FNS.approved_card_items(x, { items: [1, 2] }, S, [])[0], false);
});
Deno.test("no_false_confirmed: negations and 'confirmation id' are not claims", () => {
  const t = (r: string) => FNS.no_false_confirmed(base({ replies: ["", r] }), { turn: 1 }, S, [])[0];
  assertEquals(t("Both were submitted; neither is confirmed by the employer's email yet. Confirmation id GH-1."), true);
  assertEquals(t("Both are unconfirmed."), true);
  assertEquals(t("Both applications are confirmed."), false);
});
Deno.test("never_asked reads the stored questions", () => {
  assertEquals(FNS.never_asked(base({ questions: [{ label: "First Name", company: "x", state: "answered" }] }), { re: "(?i)first name" }, S, [])[0], false);
  assertEquals(FNS.never_asked(base({ questions: [{ label: "Are you authorized?", company: "x", state: "answered" }] }), { re: "(?i)first name" }, S, [])[0], true);
});
Deno.test("score: 10 x MUSTs, capped at 8 under half the NICEs; ungraded left out", () => {
  const r = (level: "MUST" | "NICE", pass: boolean | null) => ({ id: "x", level, pass, why: "" });
  assertEquals(score([r("MUST", true), r("MUST", true), r("NICE", false), r("NICE", false)]).score, 8);
  assertEquals(score([r("MUST", true), r("MUST", false), r("NICE", true)]).score, 5);
  assertEquals(score([r("MUST", true), r("NICE", true), r("NICE", null)]), { score: 10, must: "1/1", nice: "1/1", ungraded: 1 });
});
Deno.test("MA03 proposes-batch: a count beside the role noun on either side, and a quoted one-word reply (the rubric's own check)", async () => {
  const rubric = JSON.parse(await Deno.readTextFile(new URL("./rubric.json", import.meta.url)));
  const c = rubric.scenarios.find((s: Scenario) => s.id === "MA03").checks.find((k: { id: string }) => k.id === "proposes-batch");
  const t = (reply: string) => FNS[c.fn](base({ replies: [reply], scripted: [0] }), c.args, S, [])[0];
  // A correct proposal the old regex (a number, then a role noun within 80 characters before a period) failed: the list's "1." stops
  // at its period, and the count follows the noun.
  assertEquals(t('From your confirmed resume:\n1. data roles: 3 open (for example Lumen — Data Analyst; Kite — Data Science Intern)\nReply "data" and I\'ll queue those 3.'), true);
  assertEquals(t('I can apply you to 12 open software engineering internships in Chicago. Reply "yes" to queue them.'), true);
  assertEquals(t("I can apply you to some roles. Which ones do you want?"), false, "no count, no one-word reply");
  assertEquals(t("There are 12 open software engineering internships in Chicago. Which should I apply you to?"), false, "a count, but nothing to approve in one word");
});
