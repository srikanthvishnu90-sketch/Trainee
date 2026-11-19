// S3 r12b review (2026-11-19, PR #871 at 2789d3090 rejected): what the r12b parse and reply guards got wrong, pinned as classes.
//   1. a place written with its state, country or district after it ("in Austin TX", "in Chicago downtown") and the words after a
//      place ("to Dallas", "i guess") are never role words;
//   2. dropping a "waiting for your yes" claim about a stated fact leaves whole sentences, never a dangling "which" or "I'm", and
//      never touches a claim that names its own other object ("your yes on the interview slot");
// No model, no network.
//   deno test -A --no-check tests/architect/s3-r12b-review-20261119.test.ts
import assertNode from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { confirmClaimsDropped } from "../../supabase/functions/_shared/agent/reply_guards.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

Deno.test("r12b-review-1 a place's state, country or district, and what follows a place, are never role words", () => {
  const cases: [string, string][] = [
    ["data analyst roles in Austin TX", "austin"],
    ["data analyst roles in Chicago IL", "chicago"],
    ["data analyst roles in Austin Texas", "austin"],
    ["data analyst roles in Seattle WA", "seattle"],
    ["data analyst roles in Columbus Ohio", "columbus"],
    ["data analyst roles in Denver Colorado", "denver"],
    ["data analyst roles in Boston MA", "boston"],
    ["data analyst roles in Miami Florida", "miami"],
    ["data analyst roles in London UK", "london"],
    ["data analyst roles in Toronto Canada", "toronto"],
    ["data analyst roles in Atlanta Georgia", "atlanta"],
    ["data analyst internships in Atlanta Georgia summer 2027", "atlanta"],
    ["data analyst roles in Chicago downtown", "chicago"],
    ["data analyst roles in Chicago area", "chicago"],
    ["data analyst roles in Chicago metro hiring", "chicago"],
    ["data analyst roles in Austin to Dallas", "austin"],
    ["data analyst roles in Austin i guess", "austin"],
    ["data analyst roles in New York City", "new york"],
    // the comma form, as before (D-054)
    ["data analyst roles in Austin, TX", "austin"],
    ["data analyst roles in Boise, Idaho", "boise"],
  ];
  for (const [m, city] of cases) {
    const st = searchTextOf(m);
    eq(st.role, "data analyst", m);
    // The place starts with the city asked for (the state may stay with it), never another word.
    ok(st.place === city || String(st.place).startsWith(`${city} `), `${m}: place ${st.place}`);
  }
  // H002's class keeps its place and role.
  const h = searchTextOf("I'm a data analyst in Chicago looking for analyst roles");
  eq(h.place, "chicago");
  ok(!/\b(?:looking|chicago)\b/.test(h.role), h.role);
  // A word after the city that starts like a state code is not one ("co-op" is not Colorado): nothing of it is left in the role.
  eq(searchTextOf("data analyst roles in Chicago co-op").role, "data analyst");
  eq(searchTextOf("data analyst roles in Austin or Dallas").role, "data analyst");
  // A role written after the city stays the role.
  ok(/\bdata science\b/.test(searchTextOf("internships in Chicago data science").role));
});

Deno.test("r12b-review-2 a dropped confirmation claim leaves whole sentences and never another object's claim", () => {
  const cases: [string, string][] = [
    ["Got it. Your location is Chicago, which still needs your yes.", "Got it. Your location is Chicago."],
    ["Your goal is saved, that still needs your confirmation.", "Your goal is saved."],
    ["Your major is saved, and I'm still waiting for your yes.", "Your major is saved."],
    ["Your major is saved, and I’m still waiting for your yes.", "Your major is saved."],
    ["Your goal is noted and we're still waiting on your confirmation.", "Your goal is noted."],
    ["Your city is noted as the one I search in, but I am still waiting for your yes.", "Your city is noted as the one I search in."],
    // the claim on the next line, after a sentence about their record
    ["Your goal is saved.\nIt still needs your confirmation.", "Your goal is saved."],
    // in brackets, only the brackets go: the rest of the sentence is another claim and stands
    ["The fact is recorded (still waiting for your yes) and used in search.", "The fact is recorded and used in search."],
  ];
  for (const [r, want] of cases) eq(confirmClaimsDropped(r), want, r);
  // A claim that names its own other object is not a claim about the fact, and the sentence stays whole.
  for (const r of [
    "Your major is saved, and I'm still waiting for your yes on the interview slot at 3pm Tuesday.",
    "Your location is on file, and it still needs your approval for the referral to Dana.",
  ]) eq(confirmClaimsDropped(r), r);
  // No output ends in a function word, and none is empty.
  for (const r of [...cases.map((c) => c[0]), "It's waiting for your yes.", "Your goal is saved."]) {
    const out = confirmClaimsDropped(r);
    ok(out.trim().length > 0, r);
    ok(!/\b(?:which|that|and|but|so|i'm|i’m|i am|we're|we are|is|to|the|a|of|for|when|while)\W*$/i.test(out), `${r} => ${out}`);
  }
});

import { lengthNote, replyKind, replyLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
Deno.test("r12b-review-3 'ok' after Trainee's own question accepts it, and is not a bare acknowledgement", () => {
  const offer = [{ role: "user", content: "find me data analyst roles" }, { role: "assistant", content: "I found 3. Want me to also search Chicago for data analyst roles?" }];
  const restore = [{ role: "assistant", content: "You set aside \"I live in Denver\" last week. Is it right again?" }];
  for (const h0 of [offer, restore, null]) {
    for (const m of ["ok", "sounds good", "perfect", "great", "cool", "okay"]) {
      // (null: the history ends with this very message, after the offer)
      const h = h0 ?? [...offer, { role: "user", content: m }];
      const l = replyLength(m, h);
      ok(l.kind !== "ack", `${m} after ${JSON.stringify(h.at(-1))}: ${l.kind}`);
      ok(!/do not recap/.test(lengthNote(l)), m);
    }
  }
  // A thanks after the question is still a thanks; and after a statement, "ok" is an acknowledgement as before.
  eq(replyKind("ok thanks", offer), "ack");
  eq(replyKind("thank you", offer), "ack");
  eq(replyKind("ok", [{ role: "assistant", content: "I found 3 data analyst roles in Chicago." }]), "ack");
  eq(replyKind("ok"), "ack");
});

Deno.test("r12b-review-4 'no office' is the remote-only limit only when the office is what is ruled out", () => {
  // The office is not what is ruled out: politics, interviews, the job they have now.
  const notRemote: [string, RegExp][] = [
    ["no office politics, data analyst roles", /\bpolitics\b/],
    ["data analyst roles, no in-person interviews", /^data analyst/],
    ["I don't work in an office now but want office manager roles", /\boffice manager\b/],
  ];
  for (const [m, role] of notRemote) {
    const st = searchTextOf(m);
    eq(st.remote, false, m);
    ok(role.test(st.role), `${m}: role ${st.role}`);
  }
  ok(!/\bremote\b/.test(searchTextOf("no office politics, data analyst roles").role));
  // The office ruled out, at the end of a clause or before the words of the ask: remote only, and no word of it in the role.
  for (const m of ["data analyst roles, nothing in an office please", "data analyst roles no commute", "data analyst roles, nothing in office jobs, thanks",
    "data analyst roles, I won't work in an office", "data analyst roles, not on-site."]) {
    const st = searchTextOf(m);
    eq(st.remote, true, m);
    ok(!/\b(?:office|commute|nothing|site)\b/.test(st.role), `${m}: role ${st.role}`);
  }
});
