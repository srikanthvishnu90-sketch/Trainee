// Word-vomit benchmark (evals/word-vomit WV01, WV03, WV40): a messy search ask is searched for what it means, through the
// real handler on Postgres 16 (tests/architect/helpers/response_world.ts, no model). Before: "data anaylst" was searched as
// typed and found nothing, "in austin wait no not austin i meant anywhere remote" searched for "software wait meant python
// stuff", and dictated "um", "uh", "period" and "comma" became search words.
import assertNode from "node:assert/strict";
import { canRun, openWorld } from "./helpers/response_world.ts";
import { routingReading } from "../../supabase/functions/_shared/messy_text.ts";

const T = { sanitizeResources: false, sanitizeOps: false };

Deno.test("word-vomit: the routing reading takes the talk out and keeps every answer word as typed", () => {
  assertNode.equal(routingReading("find me software intern roles in austin wait no not austin i meant anywhere remote, python stuff"), "find me software intern roles remote, python stuff");
  assertNode.equal(routingReading("find data jobs in chicago or remote wait no not remote"), "find data jobs in chicago");
  assertNode.equal(routingReading("okay so um find me like um marketing internships in new york period and also uh what was the name of that robotics one comma the austin one"),
    "find me marketing internships in new york. and also what was the name of that robotics one, the austin one");
  assertNode.equal(routingReading("they offered me 3 thousand a month is that like 18 an hour or what"), "they offered me 3000 a month is that 18 an hour or what");
  assertNode.equal(routingReading("harborlight offered twenty seven"), "harborlight offered 27");
  // Answers, names and ordinary words are never changed: an approval is read as typed (D-MS-1).
  for (const m of ["ya do it", "yeah go for it", "ok", "ok go", "yes!!!", "yes but skip the second one", "the second one", "what is the pay period for this",
    "I'd like jobs like this", "i just like data", "can't wait to start", "email dana ruiz at bluestem", "one of them", "apply to 2 and 4"]) {
    assertNode.equal(routingReading(m), null, m);
  }
});

Deno.test({ name: "word-vomit: the handler searches a messy ask for what it means", ...T, async fn() {
  const why = canRun();
  if (why) { if (why === "FAIL") throw new Error("needs Postgres 16 in CI"); console.log(why); return; }
  const w = await openWorld(3);
  try {
    const a = await (await w.person({ resume: true })).say("ok so i need like a data anaylst internship for summer, chicago or remote is fine too honestly anything that pays lol but dont apply to anything yet i wanna see first");
    assertNode.doesNotMatch(a.reply, /anaylst/i, a.reply);
    assertNode.match(a.reply, /Lakefront Transit Analytics|Northline Health Data/, a.reply);
    const b = await (await w.person({ resume: true })).say("find me software intern roles in austin wait no not austin i meant anywhere remote, python stuff");
    assertNode.doesNotMatch(b.reply, /\bwait\b|\bmeant\b|\baustin\b/i, b.reply);
    const c = await (await w.person({ resume: true })).say("okay so um find me like um marketing internships in new york period and also uh what was the name of that robotics one comma the austin one");
    assertNode.doesNotMatch(c.reply, /\bum\b|\buh\b|\bperiod\b|\bcomma\b/i, c.reply);
  } finally { await w.close(); }
} });
