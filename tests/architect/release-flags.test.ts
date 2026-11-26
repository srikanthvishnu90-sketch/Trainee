// D-036 (owner, 2026-11-01 18:42 CT, in chat: "turn everything on that u believe is needed, to test everything end to end"):
// the release config (supabase/functions/agent-chat/release_config.ts) serves each flag of RELEASE_FLAGS on in production,
// every RELEASE_NEVER_ON switch stays off, the environment can only roll a release flag back, every reader goes through
// the config, and every module an ON flag switches on is reply code (the deploy standard's S3 re-measures when it changes).
// The full table: docs/architect/RELEASE-FLAGS-2026-11-01.md. The Telegram acceptance suite (deploy standard S4) runs the
// real handler on the same config and asserts it before its first step (tests/architect/telegram-acceptance.test.ts).
import assertNode from "node:assert/strict";
import {
  FLAG_ROLLBACK_VALUE, PRODUCTION_BRAIN, parseReleaseFlags, RELEASE_CONFIG_PATH, RELEASE_FLAGS, RELEASE_NEVER_ON, RELEASE_PENDING,
  releaseEnv, releaseFlagOn, releaseValue, servedBrain,
} from "../../supabase/functions/agent-chat/release_config.ts";
import { plannerOn } from "../../supabase/functions/agent-chat/career_planner.ts";
import { AGENT_BRAIN_RELEASED } from "../../supabase/functions/agent-chat/career_brain.ts";
import { textingNativeOn } from "../../supabase/functions/_shared/channel_voice.ts";
import { rewriteOn } from "../../supabase/functions/_shared/career_tailor_rewrite.ts";
import { replyWriterOn } from "../../supabase/functions/_shared/career_reply_writer.ts";
import { sendRailOn } from "../../supabase/functions/_shared/career_send_rail.ts";
import { knowledgeOn } from "../../supabase/functions/_shared/agent/knowledge/index.ts";
import { sandboxHostOptions } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { runOutreachFollowupsGated } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { isReplyCode, RELEASE_FLAG_PATHS } from "../../scripts/launch/reply-code.ts";
import { CHAT_SWITCHES, chatSwitches } from "../../supabase/functions/agent-chat/chat_switches.ts";
import { PROACTIVE_SWITCHES, proactiveSwitches } from "../../supabase/functions/career-proactive/switches.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
type Env = { get(k: string): string | undefined };
const envOf = (o: Record<string, string> = {}): Env => ({ get: (k) => o[k] });
// Production as the deploy leaves it: none of these switches set (trainee-go-live.sh sets CAREER_OUTREACH_FOLLOWUPS=on,
// the release value itself, and CAREER_BRAIN only with --brain).
const PROD = envOf({ ANTHROPIC_API_KEY: "sk-test-not-real" });

// The decision's lists (docs/architect/RELEASE-FLAGS-2026-11-01.md). Changing what the release turns on changes these.
const ON = ["CAREER_BRIEF_DIGEST", "CAREER_INTRO_REMINDERS", "CAREER_MAIL_TRACKING", "CAREER_MOCK_JUDGE", "CAREER_NETWORKING_DRAFT",
  "CAREER_OUTREACH_FOLLOWUPS", "CAREER_TAILOR_REWRITE", "CAREER_TEXTING_NATIVE"];
// On only once its condition is met (RELEASE_PENDING says which): the planner after its measurement and #371's fix; crisis
// moderation once #354's reader lands. Until then off, and never reported as live.
const PENDING = ["CAREER_BATCH_EXECUTOR", "CAREER_CRISIS_MODERATION", "CAREER_PLANNER"];
// D-037 (owner, 2026-11-01 20:04 CT: "turn these on: Real submissions … Sending email as the person … Reply rewriters"):
// real submission and sending as the person, with their release values. The reply rewriters stay off until measured.
// (CAREER_BATCH_EXECUTOR is pending: "executor not deployed". gmail.send is asked for incrementally at the first send, so
// GOOGLE_APPROVED_EXTRA_SCOPES stays the owner's list, not a release flag.)
const REAL_SUBMIT = { UPMORE_SCRIPT_SUBMIT_LIVE: "1", CLOUD_RUNNER_ENABLED: "on", CLOUD_PREPARE_ENABLED: "on" };
const SEND_AS_PERSON = { CAREER_EMAIL_SEND: "on", CAREER_OUTREACH_SEND: "on", CAREER_SEND_RAIL: "on" };
const D037: Record<string, string> = { ...REAL_SUBMIT, ...SEND_AS_PERSON };
// D-047 (architect ruling 2026-11-09, on the owner's order that research work in production): research answers in chat.
// D-047 amended (2026-11-09): the research brief File (CAREER_RESEARCH_BRIEF) ships with the reply.
const D047: Record<string, string> = { CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on" };
// D-049 (architect ruling 2026-11-09; architect amendment): the chat File card (spec C.2) ships on.
const D049: Record<string, string> = { CAREER_FILE_CARD: "on" };
// Architect amendment (D-060; owner, 2026-11-11, in chat: "Web research"): the knowledge layer and web research ship on, rolled back
// with CAREER_KNOWLEDGE=off. It leaves the unmeasured list; the reply writer and the judge stay there.
const D060: Record<string, string> = { CAREER_KNOWLEDGE: "on" };
// Architect amendment (D-062; owner, 2026-11-11, in chat: "be able to answer emails, find alumni, do all of it"; accepts D-043):
// public people search and the contact connector ship on, each rolled back with its own =off. Every send still needs the
// person's yes to the exact message (D-MN-2); every other flag, list and check here is unchanged.
const D062: Record<string, string> = { CAREER_PEOPLE_SEARCH: "on", CAREER_CONTACT_OUTREACH: "on" };
const ALL = [...ON, ...Object.keys(D037), ...Object.keys(D047), ...Object.keys(D049), ...Object.keys(D060), ...Object.keys(D062)].sort();
const UNMEASURED = ["CAREER_REPLY_WRITER", "CAREER_JUDGE"];

Deno.test("D-036: production serves exactly the release flags on, with the staged brain", () => {
  eq(Object.keys(RELEASE_FLAGS).sort(), ALL);
  for (const [f, v] of Object.entries(D037)) eq(releaseValue(PROD, f), v, `D-037: ${f} is served ${v} in production`);
  for (const [f, v] of Object.entries(D047)) { eq(releaseValue(PROD, f), v, `D-047: ${f} is served ${v} in production`); eq(releaseValue(envOf({ [f]: "off" }), f), "off", `D-047: ${f}=off rolls it back`); }
  ok(!RELEASE_NEVER_ON.includes("CAREER_RESEARCH_BRIEF"), "D-047 amended: the research brief File is a release flag");
  ok(sendRailOn(PROD), "D-037: the sending rail is on");
  eq(sandboxHostOptions((k) => releaseValue(PROD, k) ?? "", fetch).scriptSubmitLive, true, "D-037: the cloud sandbox submits approved applications");
  for (const f of ON) {
    eq(releaseValue(PROD, f), "on", `${f} is on in production`);
    ok(releaseFlagOn(PROD, f));
    eq(releaseEnv(PROD).get(f), "on");
  }
  eq(PRODUCTION_BRAIN, "staged");
  eq(servedBrain(PROD), "staged");
  // Through each feature's own reader, as the deployed code reads it.
  ok(!plannerOn(PROD, "u1"), "the planner is pending (measurement and #371's fix): off");
  ok(textingNativeOn(PROD), "texting-native delivery is on");
  ok(rewriteOn(PROD), "the truthful rewrite is on");
});

Deno.test("D-036 review: a pending switch is off in production and named as pending, never as on", async () => {
  eq(Object.keys(RELEASE_PENDING).sort(), PENDING);
  for (const f of PENDING) {
    ok(!(f in RELEASE_FLAGS) && !RELEASE_NEVER_ON.includes(f), `${f} is pending, not in another list`);
    eq(releaseValue(PROD, f), undefined, `${f} is off in production (read from the environment as before)`);
    ok(RELEASE_PENDING[f].length > 20, `${f} says what it waits for`);
  }
  ok(/reader pending #354/.test(RELEASE_PENDING.CAREER_CRISIS_MODERATION), "crisis moderation is reported as pending #354, not as a live layer");
  const accept = await Deno.readTextFile(`${ROOT}/tests/architect/telegram-acceptance.test.ts`);
  ok(/release_pending=\$\{Object\.keys\(RELEASE_PENDING\)/.test(accept), "the acceptance summary names the pending switches separately");
});

Deno.test("D-036 review: each chat and scheduled switch is on in production and off under its own rollback", () => {
  // Each switch is pinned to its own flag, so the rollback below rolls back the right thing.
  eq({ ...CHAT_SWITCHES }, { networkingDraft: "CAREER_NETWORKING_DRAFT", followupReminders: "CAREER_OUTREACH_FOLLOWUPS", introPush: "CAREER_INTRO_REMINDERS", mailTracking: "CAREER_MAIL_TRACKING",
    emailSend: "CAREER_EMAIL_SEND", batchExecutor: "CAREER_BATCH_EXECUTOR" });
  eq({ ...PROACTIVE_SWITCHES }, { mail: "CAREER_MAIL_TRACKING", outreachFollowups: "CAREER_OUTREACH_FOLLOWUPS", introReminders: "CAREER_INTRO_REMINDERS", briefs: "CAREER_BRIEF_DIGEST",
    outreachSend: "CAREER_OUTREACH_SEND" });
  const on = chatSwitches(PROD), pon = proactiveSwitches(PROD);
  const released = (flag: string) => flag in RELEASE_FLAGS;
  for (const [k, flag] of Object.entries(CHAT_SWITCHES)) {
    eq((on as any)[k], released(flag), `${k} (${flag}) ${released(flag) ? "on" : "off (pending)"} in production`);
    const off = chatSwitches(envOf({ [flag]: "off" })) as any;
    eq(off[k], false, `${flag}=off turns ${k} off`);
    for (const [k2, f2] of Object.entries(CHAT_SWITCHES)) if (k2 !== k) eq(off[k2], released(f2), `${flag}=off leaves ${k2} as served`);
  }
  eq(on.batchExecutor, false, "the batch executor is pending (not deployed): off");
  for (const [k, flag] of Object.entries(PROACTIVE_SWITCHES)) {
    eq((pon as any)[k], true, `${k} (${flag}) on in production`);
    eq((proactiveSwitches(envOf({ [flag]: "off" })) as any)[k], false, `${flag}=off turns the scheduled ${k} off`);
  }
});

// Every gate reads its switch: hard-wiring one (true, or a raw env read) changes these counts.
export const GATES: { file: string; expr: string; n: number }[] = [
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "model: chatSwitches(Deno.env).networkingDraft ?", n: 2 },
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "reminderPush: chatSwitches(Deno.env).followupReminders,", n: 2 },
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "introPush: chatSwitches(Deno.env).introPush,", n: 2 },
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "mailOn: chatSwitches(Deno.env).mailTracking,", n: 1 },
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "sendOn: chatSwitches(Deno.env).emailSend,", n: 2 },
  { file: "supabase/functions/agent-chat/handler-career.ts", expr: "const batchExecutorLive = chatSwitches(Deno.env).batchExecutor;", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "outreach: proactiveSwitches(Deno.env).outreachSend || proactiveSwitches(Deno.env).outreachFollowups ?", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "if (!proactiveSwitches(Deno.env).outreachSend) return { followups };", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "mail: proactiveSwitches(Deno.env).mail ?", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "|| proactiveSwitches(Deno.env).outreachFollowups ?", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "introReminders: proactiveSwitches(Deno.env).introReminders ?", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "briefs: proactiveSwitches(Deno.env).briefs ?", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "if (proactiveSwitches(Deno.env).briefs)", n: 1 },
  { file: "supabase/functions/career-proactive/index.ts", expr: "if (proactiveSwitches(Deno.env).introReminders)", n: 1 },
];
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
Deno.test("D-036 review: every chat and scheduled gate reads its switch (none hard-wired)", async () => {
  for (const g of GATES) eq(count(await Deno.readTextFile(`${ROOT}/${g.file}`), g.expr), g.n, `${g.file}: ${g.expr}`);
  // Mutation check of the pin: a hard-wired gate is caught.
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/career-proactive/index.ts`);
  ok(count(src.replace("briefs: proactiveSwitches(Deno.env).briefs ?", "briefs: true ?"), "briefs: proactiveSwitches(Deno.env).briefs ?") === 0);
});

Deno.test("D-036 review: every switch name read through the config is a known one (a misspelled name fails here)", async () => {
  const known = new Set([...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, ...Object.keys(RELEASE_PENDING)]);
  const bad: string[] = [];
  const LIT = /(?:releaseFlagOn|releaseValue)\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*"([^"]+)"\s*\)/g;
  let seen = 0;
  for (const f of await sourceFiles()) {
    for (const m of (await Deno.readTextFile(`${ROOT}/${f}`)).matchAll(LIT)) { seen++; if (!known.has(m[1])) bad.push(`${f}: ${m[1]}`); }
  }
  for (const v of [...Object.values(CHAT_SWITCHES), ...Object.values(PROACTIVE_SWITCHES)]) if (!known.has(v)) bad.push(`switch table: ${v}`);
  ok(seen >= 4, `the scan sees the literal reads (${seen})`);
  eq(bad, [], "every literal is in RELEASE_FLAGS, RELEASE_PENDING or RELEASE_NEVER_ON");
  eq([..."releaseFlagOn(env, \"CAREER_TEXTNG_NATIVE\")".matchAll(LIT)].map((m) => known.has(m[1])), [false], "a typo is caught (scan mutation check)");
});

Deno.test("D-036: every switch that stays off is off in production, and none can enter the release table", () => {
  for (const f of RELEASE_NEVER_ON) {
    ok(!Object.prototype.hasOwnProperty.call(RELEASE_FLAGS, f), `${f} is never a release flag`);
    ok(!releaseFlagOn(PROD, f), `${f} is off in production`);
    eq(releaseValue(PROD, f), undefined, `${f} is read from the environment as before (unset)`);
  }
  for (const f of UNMEASURED) ok(RELEASE_NEVER_ON.includes(f), `${f} changes reply words and is not measured yet (D-037 condition 3): off`);
  ok(!replyWriterOn(releaseEnv(PROD)), "the reply writer stays off");
  // Architect amendment (D-060): the knowledge library is served on, and its rollback turns it off.
  ok(knowledgeOn(releaseEnv(PROD)) && knowledgeOn(PROD), "D-060: the knowledge library is on in production");
  ok(!knowledgeOn(envOf({ CAREER_KNOWLEDGE: "off" })), "D-060: CAREER_KNOWLEDGE=off rolls it back");
  // Architect amendment (D-062): people search and the contact connector left the never-on list too, and each rolls back.
  ok(!RELEASE_NEVER_ON.includes("CAREER_KNOWLEDGE") && !RELEASE_NEVER_ON.includes("CAREER_PEOPLE_SEARCH") && !RELEASE_NEVER_ON.includes("CAREER_CONTACT_OUTREACH"), "D-060, D-062: knowledge, people search and the contact connector left the never-on list");
  for (const [f, v] of Object.entries(D062)) { eq(releaseValue(PROD, f), v, `D-062: ${f} is served ${v}`); eq(releaseValue(envOf({ [f]: "off" }), f), "off", `D-062: ${f}=off rolls it back`); }
  eq(AGENT_BRAIN_RELEASED, false, "the full agent brain stays pinned off");
  eq(servedBrain(envOf({ CAREER_BRAIN: "agent" })), "router", "CAREER_BRAIN=agent cannot turn the agent brain on");
});

Deno.test("D-036: the environment only rolls a release flag back", () => {
  for (const [f, v] of Object.entries(D037)) {
    eq(releaseValue(envOf({ [f]: "off" }), f), FLAG_ROLLBACK_VALUE, `D-037 kill switch: ${f}=off rolls it back`);
    eq(releaseValue(envOf({ [f]: "0" }), f), "off");
    eq(releaseValue(envOf({ [f]: v }), f), v);
  }
  ok(!sendRailOn(envOf({ CAREER_SEND_RAIL: "off" })), "the send rail's kill switch");
  eq(sandboxHostOptions((k) => releaseValue(envOf({ UPMORE_SCRIPT_SUBMIT_LIVE: "0" }), k) ?? "", fetch).scriptSubmitLive, false, "the live-submit kill switch");
  for (const f of ON) {
    eq(releaseValue(envOf({ [f]: "off" }), f), FLAG_ROLLBACK_VALUE, `${f}=off rolls it back`);
    eq(releaseValue(envOf({ [f]: " OFF " }), f), "off");
    eq(releaseValue(envOf({ [f]: "0" }), f), "off", "any other value rolls back too (a mistyped rollback still rolls back)");
    eq(releaseValue(envOf({ [f]: "of" }), f), "off");
    eq(releaseValue(envOf({ [f]: "on" }), f), "on", "set to the release value: the release value");
    eq(releaseValue(envOf({ [f]: " On " }), f), "on");
    eq(releaseValue(envOf({ [f]: "" }), f), "on", "an empty secret is unset");
  }
  // A switch outside the table cannot be turned on by the config, and the environment still turns it on as before.
  eq(releaseValue(envOf({ CAREER_REPLY_WRITER: "on" }), "CAREER_REPLY_WRITER"), "on");
  eq(releaseValue(envOf({ CAREER_JUDGE: "on" }), "CAREER_JUDGE"), "on");
  // Each feature's own reader follows its rollback.
  ok(!plannerOn(envOf({ CAREER_PLANNER: "off" }), "u1"));
  ok(!plannerOn(envOf({ CAREER_BRAIN: "router" }), "u1"), "the brain rollback turns the planner off too");
  ok(!plannerOn(envOf({ CAREER_PLANNER: "on", CAREER_PLANNER_USERS: "u2" }), "u1"), "CAREER_PLANNER_USERS still limits who gets it");
  ok(plannerOn(envOf({ CAREER_PLANNER: "on", CAREER_PLANNER_USERS: "u2,u1" }), "u1"));
  ok(!textingNativeOn(envOf({ CAREER_TEXTING_NATIVE: "off" })));
  ok(!rewriteOn(envOf({ CAREER_TAILOR_REWRITE: "off" })));
  // releaseEnv reads at call time: a rollback set after it was made is seen on the next read.
  const live: Record<string, string> = {};
  const served = releaseEnv(envOf(live));
  eq(served.get("CAREER_MAIL_TRACKING"), "on");
  live.CAREER_MAIL_TRACKING = "off";
  eq(served.get("CAREER_MAIL_TRACKING"), "off");
  eq(served.get("SUPABASE_URL"), undefined, "everything else passes through");
});

Deno.test("D-036: a scheduled release flag reaches only the person's own outbox; with it rolled back, nothing runs", async () => {
  // CAREER_OUTREACH_FOLLOWUPS: the gate the scheduled run uses (career-proactive/index.ts).
  const queued: unknown[] = [];
  let claimed = 0;
  const store = { allFollowups: async () => { claimed++; return []; }, drafts: async () => [], saveFollowups: async () => {} } as any;
  const outbox = { queue: async (...a: unknown[]) => { queued.push(a); return true; } } as any;
  const quiet = async () => new Set<string>();
  const r = await runOutreachFollowupsGated(PROD, { store, outbox, now: Date.now(), quiet } as any).catch((e) => ({ error: String(e) }));
  ok(r !== undefined && claimed === 1, "on in production: the follow-up run happens (it claims who is due)");
  eq(await runOutreachFollowupsGated(envOf({ CAREER_OUTREACH_FOLLOWUPS: "off" }), { store, outbox, now: Date.now(), quiet } as any), undefined, "rolled back: no run");
  eq(claimed, 1, "rolled back: nothing claimed");
  eq(queued.length, 0, "nothing due: nothing queued");
});

// ------------------------------------------------------------------------------------------------ every reader, the config
const FLAG_NAMES = Object.keys(RELEASE_FLAGS);
async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(`${ROOT}/${dir}`)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/test/.test(e.name)) out.push(p);
    }
  };
  for (const d of ["supabase/functions", "workers"]) await walk(d);
  return out.sort();
}
// A read of a release flag that does not go through the config would serve it off in production.
export function rawReads(text: string): string[] {
  const hits: string[] = [];
  for (const f of FLAG_NAMES) {
    const re = new RegExp(`(?:\\.get|\\benv)\\(\\s*["'\`]${f}["'\`]\\s*\\)`, "g");
    if (re.test(text)) hits.push(f);
  }
  if (/\.get\(\s*REWRITE_FLAG\s*\)/.test(text)) hits.push("CAREER_TAILOR_REWRITE");
  return hits;
}

Deno.test("D-036: no deployed code reads a release flag around the config", async () => {
  const bad: string[] = [];
  for (const f of await sourceFiles()) {
    if (f === RELEASE_CONFIG_PATH) continue;
    const hits = rawReads(await Deno.readTextFile(`${ROOT}/${f}`));
    if (hits.length) bad.push(`${f}: ${hits.join(", ")}`);
  }
  eq(bad, [], "read each release flag with releaseFlagOn (release_config.ts)");
  // The scan itself finds the old shape (mutation check of the scan).
  eq(rawReads(`if (Deno.env.get("CAREER_MAIL_TRACKING") === "on")`), ["CAREER_MAIL_TRACKING"]);
  eq(rawReads(`const on = env("CAREER_TEXTING_NATIVE") === "on"`), ["CAREER_TEXTING_NATIVE"]);
  eq(rawReads(`(env.get(REWRITE_FLAG) || "")`), ["CAREER_TAILOR_REWRITE"]);
  eq(rawReads(`releaseFlagOn(Deno.env, "CAREER_MAIL_TRACKING")`), []);
});

Deno.test("D-036: every module a release flag switches on is reply code, so S3 re-measures when it changes", async () => {
  ok(isReplyCode(RELEASE_CONFIG_PATH), "the release config is reply code: flipping a flag needs a fresh measurement");
  for (const p of RELEASE_FLAG_PATHS) ok(isReplyCode(p), `${p} is reply code`);
  // Derived from the code, not from the list: every file that reads a release flag, or calls a reader of one.
  const READERS = /releaseFlagOn\(|\b(?:textingNativeOn|rewriteOn|plannerOn|runOutreachFollowupsGated|chatSwitches|proactiveSwitches)\(/;
  const readers: string[] = [];
  for (const f of await sourceFiles()) if (READERS.test(await Deno.readTextFile(`${ROOT}/${f}`))) readers.push(f);
  for (const must of ["supabase/functions/agent-chat/career_planner.ts", "supabase/functions/_shared/channel_voice.ts",
    "supabase/functions/_shared/channel_registry.ts", "supabase/functions/trainee-telegram/handler.ts", "supabase/functions/trainee-deliver/handler.ts",
    "supabase/functions/agent-chat/handler-career.ts", "supabase/functions/career-proactive/index.ts"]) ok(readers.includes(must), `the scan finds ${must}`);
  const notReply = readers.filter((f) => !isReplyCode(f));
  eq(notReply, [], "add these to scripts/launch/reply-code.ts RELEASE_FLAG_PATHS");
});

Deno.test("D-036: the deploy standard reads the release flags at a SHA", async () => {
  const text = await Deno.readTextFile(`${ROOT}/${RELEASE_CONFIG_PATH}`);
  eq(parseReleaseFlags(text), ALL);
  eq(parseReleaseFlags(text.replace(/^\s*CAREER_MAIL_TRACKING: "on",\n/m, "")), ALL.filter((f) => f !== "CAREER_MAIL_TRACKING"), "a flag taken out is read as out");
  eq(parseReleaseFlags("export const PRODUCTION_BRAIN: ServedBrain = \"staged\";\n"), [], "a SHA before D-036: none on by config");
  const { servedFlagsAt } = await import("../../scripts/launch/deploy-standard.ts");
  const src = { fileAt: async (sha: string, _p: string) => sha === "new" ? text : null } as any;
  eq(await servedFlagsAt(src, "new"), ALL);
  eq(await servedFlagsAt(src, "old"), []);
});

Deno.test("D-036: the decision and its table are written down", async () => {
  const decisions = await Deno.readTextFile(`${ROOT}/docs/architect/DECISIONS.md`);
  ok(decisions.includes("| D-036 |"), "DECISIONS.md records D-036");
  ok(decisions.includes("turn everything on that u believe is needed, to test everything end to end"), "it quotes the ruling");
  const table = await Deno.readTextFile(`${ROOT}/docs/architect/RELEASE-FLAGS-2026-11-01.md`);
  for (const f of [...ALL, ...RELEASE_NEVER_ON, "CAREER_AGENT_SUBMIT", "CAREER_CLOUD_APPLY", "APPLY_VM", "CAREER_BRAIN"]) ok(table.includes(`\`${f}\``), `the table lists ${f}`);
});
