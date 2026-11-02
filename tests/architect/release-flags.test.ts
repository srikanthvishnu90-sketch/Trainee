// D-036 (owner, 2026-11-01 18:42 CT, in chat: "turn everything on that u believe is needed, to test everything end to end"):
// the release config (supabase/functions/agent-chat/release_config.ts) serves each flag of RELEASE_FLAGS on in production,
// every RELEASE_NEVER_ON switch stays off, the environment can only roll a release flag back, every reader goes through
// the config, and every module an ON flag switches on is reply code (the deploy standard's S3 re-measures when it changes).
// The full table: docs/architect/RELEASE-FLAGS-2026-11-01.md. The Telegram acceptance suite (deploy standard S4) runs the
// real handler on the same config and asserts it before its first step (tests/architect/telegram-acceptance.test.ts).
import assertNode from "node:assert/strict";
import {
  FLAG_ROLLBACK_VALUE, PRODUCTION_BRAIN, parseReleaseFlags, RELEASE_CONFIG_PATH, RELEASE_FLAGS, RELEASE_NEVER_ON,
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

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
type Env = { get(k: string): string | undefined };
const envOf = (o: Record<string, string> = {}): Env => ({ get: (k) => o[k] });
// Production as the deploy leaves it: none of these switches set (trainee-go-live.sh sets CAREER_OUTREACH_FOLLOWUPS=on,
// the release value itself, and CAREER_BRAIN only with --brain).
const PROD = envOf({ OPENAI_API_KEY: "sk-test-not-real" });

// The decision's lists (docs/architect/RELEASE-FLAGS-2026-11-01.md). Changing what the release turns on changes these.
const ON = ["CAREER_BRIEF_DIGEST", "CAREER_CRISIS_MODERATION", "CAREER_INTRO_REMINDERS", "CAREER_MAIL_TRACKING", "CAREER_MOCK_JUDGE", "CAREER_NETWORKING_DRAFT",
  "CAREER_OUTREACH_FOLLOWUPS", "CAREER_PLANNER", "CAREER_TAILOR_REWRITE", "CAREER_TEXTING_NATIVE"];
// The real-submit and send-as-the-person switches (the owner turns these on himself, at his first live application).
const REAL_EFFECT = ["UPMORE_SCRIPT_SUBMIT_LIVE", "CLOUD_RUNNER_ENABLED", "CLOUD_PREPARE_ENABLED", "CAREER_BATCH_EXECUTOR",
  "CAREER_EMAIL_SEND", "CAREER_OUTREACH_SEND", "CAREER_SEND_RAIL", "GOOGLE_APPROVED_EXTRA_SCOPES"];

Deno.test("D-036: production serves exactly the release flags on, with the staged brain", () => {
  eq(Object.keys(RELEASE_FLAGS).sort(), ON);
  for (const f of ON) {
    eq(releaseValue(PROD, f), "on", `${f} is on in production`);
    ok(releaseFlagOn(PROD, f));
    eq(releaseEnv(PROD).get(f), "on");
  }
  eq(PRODUCTION_BRAIN, "staged");
  eq(servedBrain(PROD), "staged");
  // Through each feature's own reader, as the deployed code reads it.
  ok(plannerOn(PROD, "u1"), "the planner is on (the staged brain is served)");
  ok(textingNativeOn(PROD), "texting-native delivery is on");
  ok(rewriteOn(PROD), "the truthful rewrite is on");
});

Deno.test("D-036: every switch that stays off is off in production, and none can enter the release table", () => {
  for (const f of RELEASE_NEVER_ON) {
    ok(!Object.prototype.hasOwnProperty.call(RELEASE_FLAGS, f), `${f} is never a release flag`);
    ok(!releaseFlagOn(PROD, f), `${f} is off in production`);
    eq(releaseValue(PROD, f), undefined, `${f} is read from the environment as before (unset)`);
  }
  for (const f of REAL_EFFECT) ok(RELEASE_NEVER_ON.includes(f), `${f} (a real submit or a send as the person) is on the never-on list`);
  for (const f of ["CAREER_REPLY_WRITER", "CAREER_KNOWLEDGE", "CAREER_JUDGE"]) ok(RELEASE_NEVER_ON.includes(f), `${f} changes reply words no measurement covers: off`);
  ok(!replyWriterOn(releaseEnv(PROD)), "the reply writer stays off");
  ok(!knowledgeOn(releaseEnv(PROD)), "the knowledge library stays off");
  ok(!sendRailOn(releaseEnv(PROD)), "the Gmail send rail stays off");
  eq(sandboxHostOptions((k) => releaseValue(PROD, k) ?? "", fetch).scriptSubmitLive, false, "the cloud runner never submits live");
  eq(AGENT_BRAIN_RELEASED, false, "the full agent brain stays pinned off");
  eq(servedBrain(envOf({ CAREER_BRAIN: "agent" })), "router", "CAREER_BRAIN=agent cannot turn the agent brain on");
});

Deno.test("D-036: the environment only rolls a release flag back", () => {
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
  eq(releaseValue(envOf({ UPMORE_SCRIPT_SUBMIT_LIVE: "1" }), "UPMORE_SCRIPT_SUBMIT_LIVE"), "1");
  // Each feature's own reader follows its rollback.
  ok(!plannerOn(envOf({ CAREER_PLANNER: "off" }), "u1"));
  ok(!plannerOn(envOf({ CAREER_BRAIN: "router" }), "u1"), "the brain rollback turns the planner off too");
  ok(!plannerOn(envOf({ CAREER_PLANNER_USERS: "u2" }), "u1"), "CAREER_PLANNER_USERS still limits who gets it");
  ok(plannerOn(envOf({ CAREER_PLANNER_USERS: "u2,u1" }), "u1"));
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
  eq(rawReads(`if (Deno.env.get("CAREER_PLANNER") === "on")`), ["CAREER_PLANNER"]);
  eq(rawReads(`const on = env("CAREER_TEXTING_NATIVE") === "on"`), ["CAREER_TEXTING_NATIVE"]);
  eq(rawReads(`(env.get(REWRITE_FLAG) || "")`), ["CAREER_TAILOR_REWRITE"]);
  eq(rawReads(`releaseFlagOn(Deno.env, "CAREER_PLANNER")`), []);
});

Deno.test("D-036: every module a release flag switches on is reply code, so S3 re-measures when it changes", async () => {
  ok(isReplyCode(RELEASE_CONFIG_PATH), "the release config is reply code: flipping a flag needs a fresh measurement");
  for (const p of RELEASE_FLAG_PATHS) ok(isReplyCode(p), `${p} is reply code`);
  // Derived from the code, not from the list: every file that reads a release flag, or calls a reader of one.
  const READERS = /releaseFlagOn\(|\b(?:textingNativeOn|rewriteOn|plannerOn|runOutreachFollowupsGated)\(/;
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
  eq(parseReleaseFlags(text), ON);
  eq(parseReleaseFlags(text.replace(/^\s*CAREER_PLANNER: "on",\n/m, "")), ON.filter((f) => f !== "CAREER_PLANNER"), "a flag taken out is read as out");
  eq(parseReleaseFlags("export const PRODUCTION_BRAIN: ServedBrain = \"staged\";\n"), [], "a SHA before D-036: none on by config");
  const { servedFlagsAt } = await import("../../scripts/launch/deploy-standard.ts");
  const src = { fileAt: async (sha: string, _p: string) => sha === "new" ? text : null } as any;
  eq(await servedFlagsAt(src, "new"), ON);
  eq(await servedFlagsAt(src, "old"), []);
});

Deno.test("D-036: the decision and its table are written down", async () => {
  const decisions = await Deno.readTextFile(`${ROOT}/docs/architect/DECISIONS.md`);
  ok(decisions.includes("| D-036 |"), "DECISIONS.md records D-036");
  ok(decisions.includes("turn everything on that u believe is needed, to test everything end to end"), "it quotes the ruling");
  const table = await Deno.readTextFile(`${ROOT}/docs/architect/RELEASE-FLAGS-2026-11-01.md`);
  for (const f of [...ON, ...RELEASE_NEVER_ON, "CAREER_AGENT_SUBMIT", "CAREER_CLOUD_APPLY", "CAREER_BRAIN"]) ok(table.includes(`\`${f}\``), `the table lists ${f}`);
});
