// Launch readiness Q3 (2026-10-26): no internal code, no screaming-snake token and no broken plural reaches a person.
// The audit read "0/1 applications ready for your yes. - a company — a role: BOARD_NOT_WIRED — no board adapter is wired
// for this posting's family in this run Found 1 role roles." from trunk's router for a LinkedIn link.
//   1. The router, through the same CareerHost the handler falls through to, over every phrasing in the eval sets
//      (evals/career: messages, heldout-live, conversations with its postings, in-flight), each conversation in order with
//      its state carried, plus the audit's probes.
//   2. The batch report (module 155) for every stop code its source names, and for a code it has never seen.
//   3. Every exported reply constant of the chat's code-first modules and the handler.
// Each reply is scanned for SCREAMING_SNAKE tokens, a doubled noun ("role roles") and internal phrases.
//   deno test -A --no-check tests/architect/reply-jargon-guard.test.ts
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const DOUBLED = /\b([a-z]+) \1s\b/gi;
const INTERNAL = /\b(from this handler|board adapter|served board list|wiring exists|in this run|request key|owned conversation|career context|MI-\d+)\b/gi;
export function jargonIn(text: string): string[] {
  return [...new Set([...(text.match(SNAKE) ?? []), ...(text.match(DOUBLED) ?? []), ...(text.match(INTERNAL) ?? [])])];
}

Deno.test("the scan itself: it finds each class of leak and passes plain sentences", () => {
  assertNode.deepEqual(jargonIn("0/1 ready. - a role: BOARD_NOT_WIRED — no board adapter is wired in this run Found 1 role roles."),
    ["BOARD_NOT_WIRED", "role roles", "board adapter", "in this run"]);
  assertNode.deepEqual(jargonIn("Found 1 role. 3 data analyst roles. I need an F-1 OPT answer; MBA, USD and 9am are fine."), []);
});

const host = (CareerHost as any).createCareerHost(core);
const AUDIT_PROBES: string[][] = [
  ["apply to https://www.linkedin.com/jobs/view/4012345678"], ["apply to https://www.indeed.com/viewjob?jk=abc123"],
  ["can you apply to jobs for me?"], ["find me data analyst jobs in chicago", "apply to these"], ["apply to 3 data analyst jobs in chicago"],
  ["apply to the data analyst role at Stripe"], ["what's my career goal?"], ["how much does this cost?"], ["are you a human?"],
  ["my name is Jordan Rivera and my email is jordan.rivera@example.test", "what do you know about me?"],
  ["I got rejected from Google today, I feel terrible"], ["show me real job postings that match my goal — with the links"], ["stop the interview"],
];

Deno.test("every reply the router gives to the eval phrasings and the audit's probes is free of codes and broken plurals", () => {
  const conv = JSON.parse(Deno.readTextFileSync(`${ROOT}evals/career/conversations.json`));
  const pool = Array.isArray(conv.postings) ? conv.postings : [];
  const convs: string[][] = [...AUDIT_PROBES];
  for (const f of ["messages.json", "heldout-live.json", "conversations.json", "in-flight.json"]) {
    const j = JSON.parse(Deno.readTextFileSync(`${ROOT}evals/career/${f}`));
    for (const it of j.items) convs.push(it.turns.map((t: any) => typeof t === "string" ? t : t.user).filter((t: unknown) => typeof t === "string" && t));
  }
  const leaks: string[] = [];
  let turns = 0;
  for (const [i, c] of convs.entries()) {
    for (const withPool of [false, true]) {
      let snapshot: unknown = null;
      for (const m of c) {
        const ctx = host.createTurnCtx({ userId: `jargon-${i}`, threadId: `t-${i}`, now: Date.parse("2026-10-26T15:00:00Z"), accountPersistence: true,
          snapshot, account: { epoch: 0, version: 0, paused: false }, postings: withPool ? pool : [] });
        const r = host.runTurn(m, ctx);
        snapshot = host.extractSnapshot(ctx);
        turns++;
        const found = jargonIn(String(r.reply ?? ""));
        if (found.length) leaks.push(`${JSON.stringify(m)} -> ${found.join(", ")}: ${String(r.reply).slice(0, 240)}`);
      }
    }
  }
  assertNode.ok(turns >= 2 * convs.length, `${turns} turns run`);
  assertNode.deepEqual(leaks, [], `${leaks.length} of ${turns} replies leak:\n${leaks.join("\n")}`);
});

Deno.test("the batch report says every stop in plain words, for every code module 155 names and for one it has never seen", () => {
  const Batch = require(`${ROOT}packages/domain/155-career-batch-apply.js`);
  const Portal = require(`${ROOT}packages/domain/149-career-portal-apply.js`);
  const src = Deno.readTextFileSync(`${ROOT}packages/domain/155-career-batch-apply.js`);
  const codes = new Set<string>(["A_CODE_NOBODY_WROTE_WORDS_FOR"]);
  for (const m of src.matchAll(/(?:stopApp\(run, app, |code: )"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): "/g)) codes.add(m[1]);
  assertNode.ok(codes.has("BOARD_NOT_WIRED") && codes.has("UNKNOWN_OUTCOME") && codes.size >= 10, [...codes].join(","));
  const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);
  const PROFILE = { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
    resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
    answers: { work_authorization: { value: "Yes", confirmed: true }, sponsorship: { value: "No", confirmed: true } } };
  const posting = (n: number) => ({ id: `JOB-J-${n}`, job_id: `JOB-J-${n}`, canonicalKey: `greenhouse:jargon${n}:analyst`, company: `Jargon Co ${n}`,
    title: "Data Analyst", role: "Data Analyst", url: `https://boards.greenhouse.io/jargon${n}/jobs/${n}`, status: "open", atsFamily: "greenhouse" });
  const leaks: string[] = [];
  for (const familyText of ["role", "data analyst", "shortlisted roles"]) {
    for (const code of codes) {
      const run = Batch.createRun({ userId: "u-jargon", familyText, count: 2, now: NOW });
      Batch.prepareRun(run, { postings: [posting(1), posting(2)], now: NOW, profile: PROFILE, log: { records: [] }, boardFor: () => Portal.createSandboxBoard({}) });
      const k = run.selected[0];
      run.apps[k].stage = "stopped";
      run.apps[k].stop = { code, reason: `internal reason for ${code} (MI-115)` };
      run.summary = Batch.summarizeRun(run);
      const text = Batch.speakSummary(run).join("\n");
      const found = jargonIn(text);
      if (found.length) leaks.push(`${familyText}/${code} -> ${found.join(", ")}`);
    }
  }
  assertNode.deepEqual(leaks, [], leaks.join("\n"));
});

Deno.test("every exported reply constant of the chat's modules is free of codes and broken plurals", async () => {
  const dirs = [`${ROOT}supabase/functions/_shared`, `${ROOT}supabase/functions/agent-chat`];
  const leaks: string[] = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile || !/^career_.*\.ts$|^handler-career\.ts$/.test(e.name)) continue;
      const mod = await import(`${dir}/${e.name}`);
      for (const [name, v] of Object.entries(mod)) {
        if (!/(REPLY|NOTE|TEXT|LINE|MESSAGE|REASON|WAIT|NEXT|REFUSED|ASK)/.test(name)) continue;
        const texts = typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : [];
        for (const t of texts) { scanned++; const found = jargonIn(t); if (found.length) leaks.push(`${e.name} ${name} -> ${found.join(", ")}`); }
      }
    }
  }
  assertNode.ok(scanned >= 20, `${scanned} reply constants scanned`);
  assertNode.deepEqual(leaks, [], leaks.join("\n"));
});

Deno.test("every reply literal the handler and the channel inbound path write is free of codes and internal phrases", () => {
  const leaks: string[] = [];
  let scanned = 0;
  for (const f of ["supabase/functions/agent-chat/handler-career.ts", "supabase/functions/_shared/channel_inbound.ts", "supabase/functions/_shared/channel_runtime.ts"]) {
    const src = Deno.readTextFileSync(`${ROOT}${f}`);
    // reply: "..." and reply: cond ? "..." : "...", and the exported *_REPLY constants' literals.
    for (const m of src.matchAll(/\b(?:reply|message)\s*:\s*([^,}\n]*(?:"(?:[^"\\]|\\.)*"[^,}\n]*)+)/g)) {
      for (const lit of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        if (!/\s/.test(lit[1])) continue;
        scanned++;
        const found = jargonIn(lit[1]);
        if (found.length) leaks.push(`${f}: ${found.join(", ")}: ${lit[1].slice(0, 120)}`);
      }
    }
    for (const m of src.matchAll(/export const [A-Z_]*REPLY[A-Z_]* = "((?:[^"\\]|\\.)*)"/g)) {
      scanned++;
      const found = jargonIn(m[1]);
      if (found.length) leaks.push(`${f}: ${found.join(", ")}: ${m[1].slice(0, 120)}`);
    }
  }
  assertNode.ok(scanned >= 5, `${scanned} literals scanned`);
  assertNode.deepEqual(leaks, [], leaks.join("\n"));
});

// The replies for a refused save (_shared/career_save_replies.ts) are built from what the turn did, so the literal scan
// above cannot see them whole: render every combination and scan it.
import { CONFLICT_CODES, refusedSaveReply } from "../../supabase/functions/_shared/career_save_replies.ts";
Deno.test("every refused-save reply is free of codes and internal phrases, says only what the turn did, and each conflict has its own wording", () => {
  assertNode.deepEqual([...CONFLICT_CODES].sort(), ["privacy_epoch_changed", "revision_conflict", "task_event_conflict", "turn_key_conflict", "watch_profile_conflict"]);
  const none = { writes: new Set<string>(), queued: 0, sent: 0, sendUnknown: 0 };
  assertNode.equal(new Set(CONFLICT_CODES.map((c) => refusedSaveReply(c, none))).size, CONFLICT_CODES.length, "no two conflicts share a reply");
  for (const code of CONFLICT_CODES) {
    for (const e of [none, { ...none, writes: new Set(["rpc:career_standing_put"]) }, { ...none, queued: 1 }, { ...none, queued: 3 }, { ...none, sent: 1 }, { ...none, sendUnknown: 1 }, { writes: new Set(["x"]), queued: 2, sent: 1, sendUnknown: 0 }]) {
      const text = refusedSaveReply(code, e);
      assertNode.deepEqual(jargonIn(text), [], `${code}: ${text}`);
      const did = e.writes.size > 0 || e.queued > 0 || e.sent > 0 || e.sendUnknown > 0;
      assertNode.equal(/Nothing new was started/.test(text), !did, `"Nothing new was started" only when the turn did nothing: ${text}`);
      assertNode.equal(/nothing was sent or submitted/i.test(text), e.queued === 0 && e.sent === 0 && e.sendUnknown === 0, `"nothing was sent" only when nothing was: ${text}`);
      if (e.queued) assertNode.ok(text.includes(e.queued === 1 ? "The application you approved" : `The ${e.queued} applications you approved`), text);
      if (e.sent) assertNode.ok(/email you approved was sent/.test(text), text);
      if (e.sendUnknown) assertNode.ok(/couldn't confirm whether the email you approved went out/.test(text), text);
      if (code !== "revision_conflict") assertNode.ok(!/conversation changed|conversation moved on/.test(text), `${code} does not claim the conversation changed`);
    }
  }
});
