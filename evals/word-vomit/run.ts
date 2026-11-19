// WORD-VOMIT, the runner (owner, 2026-11-18: "one of the largest indicators of the product being incredible is the ability to
// understand word vomit"). Sends each case of cases.json through the REAL career handler, each on its own fresh person and
// thread in the word-vomit world (world.ts): the case's state, its setup turns in order (not scored), then the messy message.
// Records what code decided: who answered (the brain or code), the router's intent, the tools the brain called and their
// inputs and errors, the rows the turn added (queue, submit, send, prepare, cards) with the queued job ids, any request that
// tried to leave the machine, and whether a File came back. grade.ts scores the transcript.
//
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/word-vomit/run.ts --dry-run [--only WV01,WV02] [--out f]
//   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN deno run -A --no-check --import-map=tests/flow/supabase-npm.json \
//     evals/word-vomit/run.ts --subscription --out evals/word-vomit/results/<label>.jsonl
//
// --subscription (D-089): every model call is answered by the `claude` CLI on the owner's subscription (evals/subscription/
// claude_cli.ts: allowlisted child environment, apiKeySource "none" checked on every call); no API key, no API spend; local only,
// never CI. It measures the committed code: it refuses a dirty supabase/, packages/ or evals/word-vomit/ (results aside) and
// records the SHA. Production's configuration: every release flag and never-on switch cleared, the brain PRODUCTION_BRAIN.
import { anthropicWire } from "../../tests/architect/helpers/anthropic_wire.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";
import { FILE_ENV } from "../mirror/heldout/harness.ts";
import { brainEnvOverrides, SUBSCRIPTION_PLACEHOLDER_KEY } from "../career/run.ts";
import { inCi } from "../subscription/claude_cli.ts";
import { type CaseState, openWordVomitWorld } from "./world.ts";

export type Case = {
  id: string; job: string; state: CaseState; setup: string[]; message: string; context?: string;
  needs: string[]; ideal_action: string; must_not: string[]; venting?: boolean;
  checks: {
    acts?: { intent?: string; tools?: string[] }; crisis?: boolean; max_questions?: number | null; max_chars?: number;
    allow_effects?: string[]; queued_excludes?: string[]; queued_includes?: string[];
  };
  specific: { id: string; text: string; kind?: "presence" | "absence" }[];
};
export type Record_ = {
  id: string; sha: string; mode: string; setup: { prompt: string; reply: string; intent: string | null }[]; message: string;
  reply: string; route: "brain" | "code"; intent: string | null; router_intent: string | null; brain_calls: number; json_calls: number;
  called: string[]; call_errors: { name: string; error: string }[]; args: { name: string; args: unknown }[];
  effects: Record<string, number>; queued: string[]; cards: number; outbound: string[]; artifact: boolean; ms: number; error?: string;
};

const EFFECT_TABLES: [string, string][] = [["career_apply_receipts", "submit"], ["career_contact_sends", "send"], ["career_outbox", "send"], ["career_outlook_sends", "send"],
  ["career_send_queue", "send"], ["career_apply_jobs", "queue"], ["career_apply_wanted", "queue"], ["career_apply_prepared", "prepare"], ["career_apply_prepare_requests", "prepare"]];
const CARD_TABLES = ["career_apply_cards", "career_apply_message_cards", "career_apply_batch_approvals"];

if (import.meta.main) {
  const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const sub = a.includes("--subscription"), dry = a.includes("--dry-run");
  if (sub === dry) { console.log("usage: run.ts --dry-run | --subscription [--only WV01,..] [--out file]"); Deno.exit(2); }
  if (a.includes("--live")) { console.log("refused: this benchmark runs on the subscription or dry, never on the API"); Deno.exit(3); }
  if (sub && inCi()) { console.log("refused: --subscription never runs in CI (D-089)"); Deno.exit(3); }
  if (sub && (Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_AUTH_TOKEN"))) { console.log("refused: unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN (env -u ...); subscription only"); Deno.exit(3); }
  const overrides = sub ? brainEnvOverrides(Deno.env.toObject()) : [];
  if (overrides.length) { console.log(`refused: the environment sets ${overrides.join(", ")}; unset them (D-089)`); Deno.exit(3); }
  const git = (...args: string[]) => new TextDecoder().decode(new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).outputSync().stdout).trim();
  const sha = git("rev-parse", "HEAD");
  if (sub) {
    const dirty = git("status", "--porcelain", "--", "supabase", "packages", "evals/word-vomit", ":(exclude)evals/word-vomit/results");
    if (dirty) { console.log(`refused: --subscription measures the committed code; uncommitted changes:\n${dirty}`); Deno.exit(3); }
    await (await import("../subscription/claude_cli.ts")).preflight();
  }
  const only = opt("--only")?.split(",");
  const cases: Case[] = JSON.parse(await Deno.readTextFile(new URL("./cases.json", import.meta.url))).filter((c: Case) => !only || only.includes(c.id));
  const out = opt("--out") ?? new URL(`./results/${dry ? "dry" : "sub"}-${sha.slice(0, 9)}.jsonl`, import.meta.url).pathname;
  const recs = await runCases(cases, { sub, sha, onCase: (r) => console.log(`${r.id} ${r.route} ${r.intent ?? ""}/${r.router_intent ?? ""} ${r.ms}ms effects=${JSON.stringify(r.effects)} :: ${r.reply.replace(/\s+/g, " ").slice(0, 160)}`) });
  await Deno.mkdir(out.replace(/[^/]*$/, ""), { recursive: true });
  await Deno.writeTextFile(out, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (sub) { const cli = await import("../subscription/claude_cli.ts"); console.log(`cli calls=${cli.stats.calls} failed=${cli.stats.failed} apiKeySource=${cli.stats.apiKeySource}`); }
  console.log(`WORD-VOMIT ${dry ? "dry" : "subscription"} ${recs.length}/${cases.length} cases at ${sha.slice(0, 9)} -> ${out}`);
}

export async function runCases(cases: Case[], o: { sub: boolean; sha: string; onCase?: (r: Record_) => void }): Promise<Record_[]> {
  let calls: { json: boolean }[] = [];
  const scripted = (chat: any) => Response.json({ id: "wv-dry", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: chat.response_format ? "{}" : "Dry run, no model." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const model = async (req: Request): Promise<Response> => {
    const body = await req.clone().json().catch(() => ({}));
    calls.push({ json: !!body.output_config?.format });
    if (!o.sub) return await anthropicWire(req, scripted);
    if (req.headers.get("x-api-key") !== SUBSCRIPTION_PLACEHOLDER_KEY) return Response.json({ type: "error", error: { type: "authentication_error", message: "subscription mode: a key other than the placeholder (D-089)" } }, { status: 401 });
    return await (await import("../subscription/claude_cli.ts")).cliFetch(req);
  };
  const w = await openWordVomitWorld(cases.length + 1, { model });
  const recs: Record_[] = [];
  try {
    for (const k of [...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON]) Deno.env.delete(k);
    Deno.env.set("CAREER_BRAIN", PRODUCTION_BRAIN);
    for (const [k, v] of Object.entries(FILE_ENV)) Deno.env.set(k, v);
    Deno.env.set("ANTHROPIC_API_KEY", o.sub ? SUBSCRIPTION_PLACEHOLDER_KEY : "sk-test-not-real");
    const cols = new Set((await w.pg.sql(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`)).split("\n").map((s) => s.trim()));
    const effects = EFFECT_TABLES.filter(([t]) => cols.has(t)), cards = CARD_TABLES.filter((t) => cols.has(t));
    const count = async (t: string, u: string) => Number((await w.pg.sql(`select count(*) from public.${t} where user_id = '${u}'`)).replace(/\D+/g, " ").trim().split(" ")[0] || 0);
    const snapshot = async (u: string) => {
      const e: Record<string, number> = {};
      for (const [t, kind] of effects) e[kind] = (e[kind] ?? 0) + await count(t, u);
      let c = 0; for (const t of cards) c += await count(t, u);
      return { e, cards: c };
    };
    const queuedIds = async (u: string) => (await w.pg.sql(`select job_id || ' ' || url from public.career_apply_jobs where user_id = '${u}' union select posting_key || ' ' || url from public.career_apply_wanted where user_id = '${u}'`)).split("\n").map((s) => s.trim()).filter((s) => /^[a-z]+:/.test(s));
    for (const c of cases) {
      const person = await w.personFor(c.state);
      const setup: Record_["setup"] = [];
      for (const s of c.setup) { const r: any = await person.say(s); setup.push({ prompt: s, reply: String(r?.reply ?? ""), intent: r?.intent ?? null }); }
      calls = [];
      const b = await snapshot(person.id), q0 = await queuedIds(person.id), outAt = w.outbound.length, t0 = performance.now();
      let r: any = null, error: string | undefined;
      try { r = await person.say(c.message); } catch (e) { error = String((e as Error).message ?? e); }
      const af = await snapshot(person.id), q1 = await queuedIds(person.id);
      const meta = r?.body?.meta ?? {};
      const reply = String(r?.reply ?? "");
      const brain = calls.filter((x) => !x.json).length;
      const tc = (meta.tool_calls ?? []) as any[];
      const rec: Record_ = {
        id: c.id, sha: o.sha, mode: o.sub ? "subscription" : "dry", setup, message: c.message, reply,
        route: brain ? "brain" : "code", intent: r?.intent ?? null, router_intent: meta.router_intent ?? null, brain_calls: brain, json_calls: calls.length - brain,
        called: tc.map((x) => String(x?.name ?? x)), call_errors: tc.filter((x) => x && x.ok === false).map((x) => ({ name: String(x.name), error: String(x.error ?? "").slice(0, 300) })),
        args: tc.filter((x) => x && x.args).map((x) => ({ name: String(x.name), args: x.args })),
        effects: Object.fromEntries(Object.keys(af.e).map((k) => [k, af.e[k] - (b.e[k] ?? 0)]).filter(([, v]) => (v as number) > 0)),
        queued: q1.filter((x) => !q0.includes(x)), cards: af.cards - b.cards, outbound: w.outbound.slice(outAt),
        artifact: !!(r?.body?.artifacts?.length || r?.body?.file_cards?.length) || reply.includes(FILE_ENV.TRAINEE_FILE_BASE_URL) || (r?.body?.shape?.links ?? []).length > 0,
        ms: Math.round(performance.now() - t0), ...(error ? { error } : {}),
      };
      recs.push(rec);
      o.onCase?.(rec);
    }
  } finally {
    for (const k of [...Object.keys(FILE_ENV), "ANTHROPIC_API_KEY", "CAREER_BRAIN"]) Deno.env.delete(k);
    await w.close();
  }
  return recs;
}
