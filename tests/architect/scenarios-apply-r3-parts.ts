// The in-memory half of apply round 3, in two parts (scenarios-apply-r3.test.ts: even scenarios + the regressions;
// scenarios-apply-r3-2.test.ts: odd scenarios). Together they run every generated scenario once.
import { eq, memWorld, newReport, parsePage, printReport, quarantineRulesAgree, runScenario, SCENARIOS, SECRET_LINK, T0, U } from "./scenarios-apply-r3-battery.ts";
import { phonePost } from "./file-session-fakes.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { tapJob } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { unsendableWhy, untrustedAnswers } from "../../supabase/functions/_shared/apply_trust.ts";
import { payloadTrust } from "../../workers/career-browser/approve-first.ts";
import { CATS, type Scenario } from "./scenarios/apply-r3-generator.ts";

const one = (over: Partial<Scenario>): Scenario => ({ id: 900_000 + Math.floor(Math.random() * 1000), cat: "answers", account: { epoch: 0, version: 5, authority: 0, paused: false }, skew: 0,
  posts: [{ n: 1, company: "Acme", provider: "greenhouse", prep: { expiresIn: 7 * 86_400_000, stamp: "current", fields: ["plain"], quarantine: "current" }, elsewhere: null }], steps: [], ...over });
async function drawAndTap(s: Scenario, mutate?: (w: Awaited<ReturnType<typeof memWorld>>) => Promise<void>) {
  const w = await memWorld(s);
  const get = () => handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${w.tokens.A}` } }), w.deps);
  const page = parsePage(await (await get()).text());
  if (mutate) await mutate(w);
  const tag = page.rows[0].tag ?? "none";
  const tap = await (await handleFile(new Request("https://trainee.example/file", await phonePost({ t: w.tokens.A, action: "apply", ref: w.posts[0].ref, tag }, SECRET_LINK)), w.deps)).text();
  const said: string[] = [];
  await tapJob({ userId: U, data: `jca:${w.posts[0].ref}`, messageId: null, deps: w.deps, send: { photo: async () => ({ ok: true }), text: async (a: { text: string; buttons?: unknown }) => { said.push(`${a.text}${a.buttons ? " [buttons]" : ""}`); return { ok: true, id: null }; } } as never });
  return { w, page, tap, said, apps: (await w.truth()).apps };
}

export async function applyR3Tests(part: 0 | 1) {
  if (part === 0) {
    Deno.test("apply r3: both parts are on disk and register their halves", async () => {
      for (const f of ["scenarios-apply-r3.test.ts", "scenarios-apply-r3-2.test.ts"]) {
        const t = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
        if (!/applyR3Tests\([01]\)/.test(t)) throw new Error(`${f} does not run its part`);
      }
    });
    Deno.test("apply r3: the page and Confirm judge answers by the worker's own quarantine rules", () => {
      quarantineRulesAgree();
      const pl = (fields: unknown[], extra: Record<string, unknown> = {}) => ({ user_id: U, fields, ...extra });
      for (const p of [pl([{ label: "A", factId: "F-031" }]), pl([{ label: "A", factId: " F-0079 " }]), pl([{ label: "A", provenance: "answer-all" }]), pl([{ label: "A", derived_from: ["F-28"] }]),
        pl([{ label: "A", derivedFrom: "F-1" }]), pl([{ label: "A", factId: "text-answer:x" }]), pl([], { quarantine_version: "d007-v0" }), pl([{ label: "A", factId: "F-002" }]), pl([{ label: "A", factId: "F-026" }, { label: "B", factId: "F-080" }])]) {
        eq(untrustedAnswers(p).length > 0, payloadTrust(p).length > 0, JSON.stringify(p));
      }
      eq(untrustedAnswers(pl([{ label: "A", factId: "F-002", user_id: "someone-else" }])).length, 1, "another account's fact");
    });
    // The bugs this round found, one each, before the battery.
    Deno.test("apply r3 regression: an application past its own expiry is not offered, and neither the page nor Telegram approves it", async () => {
      const r = await drawAndTap(one({ posts: [{ n: 1, company: "Acme", provider: "greenhouse", prep: { expiresIn: 60_000, stamp: "current", fields: ["plain"], quarantine: "current" }, elsewhere: null }] }));
      eq(r.page.rows[0].tag, null, "no Apply bound to an expiring payload");
      eq(r.apps.length, 0);
      if (!/expired before it was approved/.test(r.tap)) throw new Error("the row says why");
      if (r.said.some((x) => x.includes("[buttons]"))) throw new Error("Telegram offered Confirm on an expired payload");
      eq(unsendableWhy({ expires_at: new Date(T0 + 121_000).toISOString() }, { now: T0 }), null, "two minutes and a second ahead is offered");
    });
    Deno.test("apply r3 regression: an answer from the quarantined bank, an answer-all delegation or another account's fact is never approved", async () => {
      for (const k of ["q_bank", "q_answer_all", "q_derived", "text_no_key", "other_owner"] as const) {
        const r = await drawAndTap(one({ posts: [{ n: 1, company: "Acme", provider: "greenhouse", prep: { expiresIn: 7 * 86_400_000, stamp: "current", fields: ["plain", k], quarantine: "current" }, elsewhere: null }] }));
        eq([r.page.rows[0].tag, r.apps.length], [null, 0], k);
        if (r.said.some((x) => x.includes("[buttons]"))) throw new Error(`Telegram offered Confirm (${k})`);
        if (r.tap.includes("VSECRETR3")) throw new Error("another account's value printed");
      }
    });
    Deno.test("apply r3 regression: paused, forgotten or fenced after preparing: no Apply, nothing approved, and the row says why", async () => {
      for (const [m, re] of [["pause", /paused/], ["forget", /details changed/], ["fence", /details changed/], ["erase", /signed out|isn't valid/i]] as const) {
        const r = await drawAndTap(one({}), async (w) => { await w.mutate({ m } as never); });
        eq(r.apps.length, 0, m);
        if (!re.test(r.tap)) throw new Error(`${m}: ${r.tap.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400)}`);
      }
      const bump = await drawAndTap(one({}), async (w) => { await w.mutate({ m: "bump" }); });
      eq(bump.apps.length, 1, "a version bump that doesn't pass the fence changes nothing");
    });
    Deno.test("apply r3 regression: a posting already sent through the extension or under another link shows a status, and Apply approves nothing", async () => {
      for (const how of ["extension", "alt_id"] as const) {
        const r = await drawAndTap(one({ posts: [{ n: 1, company: "Acme", provider: "lever", prep: { expiresIn: 7 * 86_400_000, stamp: "current", fields: ["plain"], quarantine: "current" }, elsewhere: how }] }));
        eq([r.page.rows[0].tag, r.page.rows[0].chip], [null, "in-applications"], how);
        eq(r.apps.filter((a) => !a.job_id.startsWith("custom:")).length, 0, how);
        if (r.said.some((x) => x.includes("[buttons]"))) throw new Error(`Telegram offered Confirm (${how})`);
      }
    });
  }
  Deno.test({ name: `apply r3 in memory, part ${part + 1}: ${Math.ceil(SCENARIOS.length / 2)} scenarios (expiry, account, answers, resume, elsewhere, devices, session, scale) through the handler and Telegram's Confirm; every check after every request`, sanitizeOps: false, sanitizeResources: false, async fn() {
    const rep = newReport();
    const started = Date.now();
    const only = Deno.env.get("R3_ONLY");
    const run = only ? SCENARIOS.filter((s) => only.split(",").includes(String(s.id))) : SCENARIOS.filter((s) => Math.floor(s.id / CATS.length) % 2 === part);
    for (const s of run) await runScenario(s, await memWorld(s), rep);
    console.log(`[apply r3] memory part ${part + 1}: ${run.length} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const failed = printReport(`memory part ${part + 1}`, rep);
    if (!only) for (const [k, min] of [["rows offered for approval", 2000], ["rows held back (not offered)", 500], ["queued via apply", 300], ["queued via applyall", 100], ["queued via tg_confirm", 100],
      ["telegram offered Confirm", 200], ["taps on an ended session", 100], ["apply past the first 30", 50], ["another account's ref posted", 50], ["link minted too far ahead", 20], ["link minted within the skew", 50]] as const) {
      if ((rep.counts[k] ?? 0) < min) throw new Error(`liveness: "${k}" reached only ${rep.counts[k] ?? 0} times (want ${min})`);
    }
    eq(failed, 0, "every check held after every request");
  } });
}
