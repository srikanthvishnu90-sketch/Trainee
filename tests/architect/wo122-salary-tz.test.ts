// WO-122 on D-053b's salary suggestion (architect, 2026-11-10): the Supabase reader of a salary expectation on file
// (career_apply_questions.ts supabaseQuestionStore.earlierSalary, #750) passes the person's IANA zone, read from
// career_alert_prefs.tz as WO-122's card does, so an answer the person texted to another posting is labelled
// "(from your answer on <Mon D>)" in their own day. Before, the reader returned no zone and every such answer was labelled
// "(from your confirmed facts)". A UTC date is never printed: with no zone saved, a UTC alias, an unreadable zone, or a
// failed read of it, the suggestion keeps the no-date label (WO-122: a UTC date can be the wrong day).
// Run: deno test -A --no-check tests/architect/wo122-salary-tz.test.ts
import assertNode from "node:assert/strict";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { type OpenQuestion, type QuestionStore, questionsTurn, supabaseQuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";

const T0 = Date.UTC(2026, 10, 10, 15);
const SALARY = "What are your salary expectations?";
// 03:00 UTC on Nov 4 is the evening of Nov 3 in Chicago: a UTC date would be the wrong day.
const ANSWERED_AT = "2026-11-04T03:00:00.000Z";
const ROWS = [
  { id: "r1", label: SALARY, type: "input_text", answer: "$90,000", answered_at: ANSWERED_AT, job_ids: ["gh:acme:1"] },
  { id: "r2", label: "Are you willing to relocate?", type: "input_text", answer: "No", answered_at: ANSWERED_AT, job_ids: ["gh:acme:1"] },
];

type Call = { table: string; ops: [string, unknown[]][] };
// A Supabase client double: each table answers with its data (a list, or one row for maybeSingle), or with an error.
function fakeAdmin(tables: Record<string, { data?: unknown; error?: { message: string } }>) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const rec: Call = { table, ops: [] };
      calls.push(rec);
      const b: any = new Proxy({}, {
        get(_t, k: string) {
          if (k === "then") return (res: any) => res({ data: tables[table]?.data ?? null, error: tables[table]?.error ?? null });
          return (...a: unknown[]) => { rec.ops.push([k, a]); return b; };
        },
      });
      return b;
    },
  };
  return { admin, calls };
}
const scopedTo = (c: Call | undefined, user: string) => !!c && c.ops.some(([k, a]) => k === "eq" && a[0] === "user_id" && a[1] === user);

Deno.test("WO-122/S1 the reader returns the person's saved zone from career_alert_prefs.tz, read for that person only", async () => {
  const { admin, calls } = fakeAdmin({ career_apply_questions: { data: ROWS }, career_alert_prefs: { data: { tz: "America/Chicago" } } });
  const onFile = await supabaseQuestionStore(admin).earlierSalary!("user-7");
  assertNode.equal(onFile.tz, "America/Chicago");
  assertNode.deepStrictEqual(onFile.answers, [{ value: "$90,000", factId: "text-answer:r1", at: ANSWERED_AT, job_ids: ["gh:acme:1"] }], "salary rows only");
  const prefs = calls.find((c) => c.table === "career_alert_prefs");
  assertNode.ok(scopedTo(prefs, "user-7"), "the zone is the person's own: " + JSON.stringify(prefs));
  assertNode.ok(prefs!.ops.some(([k, a]) => k === "select" && /\btz\b/.test(String(a[0]))), "reads tz");
  assertNode.ok(scopedTo(calls.find((c) => c.table === "career_apply_questions"), "user-7"));
});

Deno.test("WO-122/S2 no zone saved, or a failed read of it: the answers are still returned, with no zone", async () => {
  for (const prefs of [{ data: null }, { data: { tz: null } }, { error: { message: "permission denied" } }]) {
    const { admin } = fakeAdmin({ career_apply_questions: { data: ROWS }, career_alert_prefs: prefs });
    const onFile = await supabaseQuestionStore(admin).earlierSalary!("user-7");
    assertNode.equal(onFile.tz, undefined, JSON.stringify(prefs));
    assertNode.equal(onFile.answers.length, 1, JSON.stringify(prefs));
  }
});

// ------------------------------------------------------------------------------------------------ the label the person reads
const Q = (): OpenQuestion => ({
  id: "q-sal", key: answerKey({ label: SALARY, type: "input_text", options: [] }, "gh:beta:2"), kind: "fact", label: SALARY, type: "input_text",
  options: [], company: "Beta", job_ids: ["gh:beta:2"], misfit: false, answer: null,
});
// The questions flow on an in-memory store, with the salary on file read by the product's Supabase reader.
function storeWith(reader: QuestionStore["earlierSalary"]) {
  const rows = [Q()];
  const kv: { shown?: any } = {};
  const store: QuestionStore = {
    async open(_u, limit) { return rows.filter((r) => !r.answer).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { rows.find((x) => x.id === id)!.answer = a; },
    async shown() { return kv.shown ? JSON.parse(JSON.stringify(kv.shown)) : null; },
    async setShown(_u, s) { kv.shown = JSON.parse(JSON.stringify(s)); },
    async lastAssistantIntent() { return null; },
    earlierSalary: reader,
  };
  return store;
}
async function shownFor(prefs: { data?: unknown; error?: { message: string } }) {
  const { admin } = fakeAdmin({ career_apply_questions: { data: ROWS }, career_alert_prefs: prefs });
  const r = await questionsTurn({ message: "what do you need from me", userId: "user-7", threadId: "t", now: T0, store: storeWith(supabaseQuestionStore(admin).earlierSalary) });
  assertNode.ok(r && r.status === "shown", JSON.stringify(r));
  return r!.reply;
}

Deno.test("WO-122/S3 an earlier texted salary is labelled with the day it was given, in the person's own zone", async () => {
  const reply = await shownFor({ data: { tz: "America/Chicago" } });
  assertNode.ok(reply.includes("$90,000 (from your answer on Nov 3)"), reply);
  assertNode.ok(!reply.includes("from your confirmed facts"), reply);
  assertNode.ok(!/Nov 4/.test(reply), "never the UTC day: " + reply);
  // Another zone, another day where the zone says so.
  const tokyo = await shownFor({ data: { tz: "Asia/Tokyo" } });
  assertNode.ok(tokyo.includes("$90,000 (from your answer on Nov 4)"), tokyo);
});

Deno.test("WO-122/S4 never a UTC date: no zone, a UTC alias, an unreadable zone or a failed read keeps the no-date label", async () => {
  for (const prefs of [{ data: null }, { data: { tz: "UTC" } }, { data: { tz: "Etc/GMT" } }, { data: { tz: "Not/AZone" } }, { error: { message: "timeout" } }]) {
    const reply = await shownFor(prefs);
    assertNode.ok(reply.includes("$90,000 (from your confirmed facts)"), `${JSON.stringify(prefs)}: ${reply}`);
    assertNode.ok(!/from your answer on/.test(reply) && !/Nov \d/.test(reply), `${JSON.stringify(prefs)}: ${reply}`);
  }
});
