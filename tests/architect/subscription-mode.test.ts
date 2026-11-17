// D-089 (owner, 2026-11-16: "yes" to the local subscription mode): evals/career/run.ts --subscription answers every model
// call with the `claude` CLI on the owner's subscription (evals/subscription/claude_cli.ts). Review of #853:
//   B3  the run measures the committed code: any environment variable that changes the brain, its model or effort, the
//       gateway, the judges or a switch the reply path reads refuses the run, before any CLI call; the result records the rule.
//   the bridge refuses CI whoever imports it, strips every provider/billing switch from the child, routes only the Messages
//   endpoint itself (not count_tokens or batches), and refuses EVERY call whose own init event is not apiKeySource "none".
// No real CLI and no model: a fake `claude` on PATH records its argv, environment, folder and input, and prints the CLI's
// stream-json events. The end-to-end run sends every outbound request to a local proxy that refuses it and counts it.
// Run: deno test -A --no-check tests/architect/subscription-mode.test.ts
import assertNode from "node:assert/strict";
import { BRAIN_ENV_NAMES, brainEnvCheck, brainEnvOverrides, enterSubscriptionEnv, SUBSCRIPTION_CLEARED, SUBSCRIPTION_PLACEHOLDER_KEY, subscriptionFetch } from "../../evals/career/run.ts";
import { RELEASE_FLAGS } from "../../supabase/functions/agent-chat/release_config.ts";
import { canRun } from "./helpers/response_world.ts";
import { pgBinDir } from "../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("B3: every variable that changes the brain, the gateway or the judges is an override; unrelated and removed keys are not", () => {
  const named = ["CAREER_BRAIN_ROUTER_INTENTS", "CAREER_BRAIN", "CAREER_MODEL", "MODEL_PROVIDER", "ANTHROPIC_EFFORT", "CAREER_REPLY_MODEL",
    "ANTHROPIC_MODEL", "ANTHROPIC_ROUTER_MODEL", "ANTHROPIC_BASE_URL", "EVAL_JUDGE_MODEL", "EVAL_JUDGE_MODEL_2", "EVAL_SEALED_PATH", "CAREER_REPLY_WRITER",
    "CAREER_JUDGE", "CAREER_JUDGE_N", "CAREER_PLANNER", "MODEL_BUDGET_PAUSED", "APPLY_VM", "RESEARCH_PROVIDER", "BRAVE_API_KEY", Object.keys(RELEASE_FLAGS)[0]];
  for (const k of named) eq(brainEnvOverrides({ [k]: "x" }), [k], k);
  eq(brainEnvOverrides({ CAREER_MODEL: "" }), ["CAREER_MODEL"], "set but empty still counts");
  eq(brainEnvOverrides({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", EVAL_LEDGER: "x", CLAUDECODE: "1" }), []);
  for (const k of Object.keys(RELEASE_FLAGS)) ok(BRAIN_ENV_NAMES.includes(k), `release flag ${k} is checked`);
  const c = brainEnvCheck(); ok(c.prefixes.includes("CAREER_") && c.names.length > 0 && c.removed.includes("ANTHROPIC_API_KEY"));
});

const PASS_ENV = () => ({ PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", HOME: Deno.env.get("HOME") ?? "/tmp" });
// sources: each call's apiKeySource in turn ("none" when the list runs out); "SLOW:<src>" prints the init, then waits 3 s and
// marks that it went on (what a real CLI would do next: send the model request); "NONL:<src>" does the same with the init
// line's newline missing; "NOINIT" prints a result with no init event at all.
async function fakeClaude(sources: string[] = []): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "fake-claude-" });
  await Deno.writeTextFile(`${dir}/sources`, sources.join("\n") + "\n");
  await Deno.writeTextFile(`${dir}/claude`, `#!/bin/sh
d="${dir}"
echo $$ >> "$d/calls"; n=$(grep -n "^$$\$" "$d/calls" | cut -d: -f1)
cat > "$d/stdin.$$"
env > "$d/env.$$"; pwd > "$d/cwd.$$"; ls -A > "$d/ls.$$"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/args.$$"
src=$(sed -n "\${n}p" "$d/sources"); [ -z "$src" ] && src=none
case "$src" in SLOW:*) echo '{"type":"system","subtype":"init","apiKeySource":"'\${src#SLOW:}'"}'; sleep 3; touch "$d/went-on";;
  NONL:*) printf '%s' '{"type":"system","subtype":"init","apiKeySource":"'\${src#NONL:}'"}'; sleep 3; touch "$d/went-on";;
esac
[ "$src" = NOINIT ] || echo '{"type":"system","subtype":"init","apiKeySource":"'$src'"}'
echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"content":[{"type":"text","text":"ok"}]},"usage":{"input_tokens":1,"output_tokens":1}}'
`);
  await Deno.chmod(`${dir}/claude`, 0o755);
  return dir;
}
// The calls in order (each one's files are keyed by the fake's process id).
const ids = async (dir: string) => { try { return (await Deno.readTextFile(`${dir}/calls`)).split("\n").filter(Boolean); } catch { return []; } };
const calls = async (dir: string) => (await ids(dir)).length;
const file = async (dir: string, kind: string, n: number) => await Deno.readTextFile(`${dir}/${kind}.${(await ids(dir))[n - 1]}`);
const envKeys = async (dir: string, n: number) => (await file(dir, "env", n)).split("\n").filter(Boolean).map((l) => l.split("=")[0]);
// The keys sh itself adds to the environment it prints.
const SH_KEYS = ["PWD", "SHLVL", "_", "OLDPWD"];
const ALLOWED = (k: string) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", ...SH_KEYS].includes(k) || /^LC_[A-Z_]+$/.test(k);
async function run(args: string[], env: Record<string, string>) {
  const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", ...args], cwd: ROOT, env, clearEnv: true, stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}
async function withEnv<T>(set: Record<string, string | null>, f: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(set)) v === null ? Deno.env.delete(k) : Deno.env.set(k, v);
  try { return await f(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
}

Deno.test("B3: run.ts --subscription refuses an override before any CLI call (exit 2, names the variable)", async () => {
  const dir = await fakeClaude();
  const r = await run(["evals/career/run.ts", "--subscription", "--brain", "staged", "--set", "dev", "--label", "b3-refusal"], { ...PASS_ENV(), PATH: `${dir}:${Deno.env.get("PATH")}`, CAREER_MODEL: "claude-haiku-4-5", MODEL_PROVIDER: "openai" });
  eq(r.code, 2, r.out);
  ok(/NOT RUN: --subscription measures the committed code, but the environment sets CAREER_MODEL, MODEL_PROVIDER/.test(r.out), r.out);
  eq(await calls(dir), 0, "no CLI call was made");
});
Deno.test("CI refusal: run.ts and run-conversation.ts refuse CI set (even empty) or GITHUB_ACTIONS, before any CLI call", async () => {
  const dir = await fakeClaude();
  const env = { ...PASS_ENV(), PATH: `${dir}:${Deno.env.get("PATH")}` };
  for (const ci of [{ CI: "" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }] as Record<string, string>[]) {
    const r = await run(["evals/career/run.ts", "--subscription", "--brain", "staged", "--set", "dev", "--label", "ci-refusal"], { ...env, ...ci });
    eq(r.code, 2, r.out); ok(/NOT RUN: --subscription never runs in CI/.test(r.out), r.out);
    const m = await run(["--import-map=tests/flow/supabase-npm.json", "evals/mirror/run-conversation.ts", "--subscription", "--conv", "/nonexistent.json"], { ...env, ...ci });
    eq(m.code, 3, m.out); ok(/refused: --subscription runs alone and never in CI/.test(m.out), m.out);
  }
  const o = await run(["--import-map=tests/flow/supabase-npm.json", "evals/mirror/run-conversation.ts", "--subscription", "--conv", "/nonexistent.json"], { ...env, ANTHROPIC_EFFORT: "high" });
  eq(o.code, 3, o.out); ok(/refused: --subscription measures the committed code, but the environment sets ANTHROPIC_EFFORT/.test(o.out), o.out);
  eq(await calls(dir), 0, "no CLI call was made");
});

Deno.test("bridge: the child's environment is an allowlist; only the Messages endpoint itself goes to the CLI", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  ok(cli.isMessagesUrl("https://api.anthropic.com/v1/messages"));
  ok(cli.isMessagesUrl("https://api.anthropic.com/v1/messages?beta=true"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/count_tokens"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/batches"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/batches/msgbatch_1/results"));
  const leak = { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
    AWS_BEARER_TOKEN_BEDROCK: "b", ANTHROPIC_FOUNDRY_API_KEY: "f", ANTHROPIC_BEDROCK_BASE_URL: "u", ANTHROPIC_VERTEX_PROJECT_ID: "p", ANTHROPIC_CUSTOM_HEADERS: "h",
    CLAUDE_CONFIG_DIR: "/x", CLAUDE_EFFORT: "high", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HTTPS_PROXY: "http://x", NODE_OPTIONS: "--require x" };
  const keep = { PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", TMPDIR: "/t", LANG: "en_US.UTF-8", LC_ALL: "C", TERM: "xterm" };
  eq(cli.childEnv({ ...leak, ...keep }), keep);
});
Deno.test("bridge: subscriptionFetch routes the Messages endpoint to the CLI and everything else below; the env setup clears the keys", async () => {
  const seen: string[] = [];
  const f = subscriptionFetch(async (r) => { seen.push(`cli ${r.url}`); return new Response("{}"); }, (await import("../../evals/subscription/claude_cli.ts")).isMessagesUrl,
    (async (r: Request) => { seen.push(`below ${r.url}`); return new Response("{}"); }) as typeof fetch);
  await f("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
  await f(new Request("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", body: "{}" }));
  await f("https://example.com/x");
  eq(seen, ["cli https://api.anthropic.com/v1/messages", "below https://api.anthropic.com/v1/messages/count_tokens", "below https://example.com/x"]);
  const ops: string[] = [];
  enterSubscriptionEnv({ delete: (k) => ops.push(`-${k}`), set: (k, v) => ops.push(`+${k}=${v}`) });
  eq(ops, [...SUBSCRIPTION_CLEARED.map((k) => `-${k}`), `+ANTHROPIC_API_KEY=${SUBSCRIPTION_PLACEHOLDER_KEY}`]);
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EVAL_LEDGER"]) ok(SUBSCRIPTION_CLEARED.includes(k), k);
});

Deno.test("bridge: CI refused in preflight (also once preflighted) and in every CLI call; isolation flags, empty folder and allowlisted env", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  const dir = await fakeClaude(["none", "none", "ANTHROPIC_API_KEY"]);
  const body = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  await withEnv({ CI: "", GITHUB_ACTIONS: null }, async () => {
    await assertNode.rejects(() => cli.preflight(), /never runs in CI/);
    await assertNode.rejects(() => cli.runCli(["-p"], "x"), /never runs in CI/);
  });
  await withEnv({ CI: null, GITHUB_ACTIONS: "true" }, async () => {
    await assertNode.rejects(() => cli.messages(body), /never runs in CI/);
  });
  await withEnv({ CI: null, GITHUB_ACTIONS: null, PATH: `${dir}:${Deno.env.get("PATH")}`, CLAUDE_CODE_USE_FOUNDRY: "1", AWS_BEARER_TOKEN_BEDROCK: "b", CLAUDECODE: "1" }, async () => {
    const res = await cli.messages(body); // call 1: preflight, call 2: the request
    eq(res.content, [{ type: "text", text: "ok" }]);
    for (const n of [1, 2]) {
      const bad = (await envKeys(dir, n)).filter((k) => !ALLOWED(k));
      for (const k of ["PATH", "HOME"]) ok((await envKeys(dir, n)).includes(k), `call ${n}: the child keeps ${k} (the CLI needs it to find its sign-in)`);
      eq(bad, [], `call ${n}: the child holds only allowlisted keys`);
      const args = (await file(dir, "args", n)).split("\n");
      for (const [flag, val] of [["--setting-sources", "project"], ["--tools", ""], ["--output-format", "stream-json"]]) ok(args[args.indexOf(flag) + 1] === val, `call ${n}: ${flag} ${val}`);
      for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence", "--verbose"]) ok(args.includes(flag), `call ${n}: ${flag}`);
      const cwd = (await file(dir, "cwd", n)).trim();
      ok(/claude-cli-empty-/.test(cwd) && cwd !== Deno.cwd(), `call ${n} runs in the empty folder, not ${cwd}`);
      eq((await file(dir, "ls", n)).trim(), "", "and it is empty");
    }
    await assertNode.rejects(() => cli.messages(body), /apiKeySource is "ANTHROPIC_API_KEY", not "none"/); // call 3: refused
    eq(cli.stats.apiKeySource, "ANTHROPIC_API_KEY", "the refused source stays recorded");
    // Once preflighted, CI is still refused.
    await withEnv({ CI: "1" }, async () => { await assertNode.rejects(() => cli.preflight(), /never runs in CI/); });
  });
});

Deno.test("bridge: a call whose init is not apiKeySource none is killed at the init, before the CLI goes on to a model request", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  const dir = await fakeClaude(["SLOW:ANTHROPIC_API_KEY"]);
  await withEnv({ CI: null, GITHUB_ACTIONS: null, PATH: `${dir}:${Deno.env.get("PATH")}` }, async () => {
    const t0 = performance.now();
    await assertNode.rejects(() => cli.runCli(["-p"], "x"), /apiKeySource is "ANTHROPIC_API_KEY".*stopped before any model request/);
    ok(performance.now() - t0 < 2500, "refused at the init, not after the call ended");
    await new Promise((r) => setTimeout(r, 3500));
    let went = true; try { await Deno.stat(`${dir}/went-on`); } catch { went = false; }
    eq(went, false, "the child was killed: it never went on past the init");
  });
});

Deno.test("end to end: run.ts --subscription with a real-looking key sends nothing out; every model call reaches the fake CLI, isolated", async () => {
  const dir = await fakeClaude();
  const log: string[] = [];
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  (async () => { for await (const c of l) { const b = new Uint8Array(4096); const n = await c.read(b).catch(() => null); log.push(new TextDecoder().decode(b.subarray(0, n ?? 0)).split("\r\n")[0]); await c.write(new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")).catch(() => {}); c.close(); } })().catch(() => {});
  const KEY = "sk-ant-api03-" + "Q".repeat(80) + "-AA";
  const label = `e2e-subscription-${crypto.randomUUID().slice(0, 8)}`;
  const proxy = `http://127.0.0.1:${port}`;
  try {
    const r = await run(["evals/career/run.ts", "--subscription", "--brain", "staged", "--set", "dev", "--only", "H001", "--label", label],
      { ...PASS_ENV(), PATH: `${dir}:${Deno.env.get("PATH")}`, ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
        // the database and the shared ledger are cleared too: with them the run would read the ledger over the network
        SUPABASE_URL: proxy, SUPABASE_SERVICE_ROLE_KEY: "service-role-not-a-key", EVAL_LEDGER: "shared" });
    ok(/subscription mode \(D-089\)/.test(r.out), r.out);
    eq(log, [], `no request left the process:\n${r.out.slice(-1500)}`);
    const n = await calls(dir);
    ok(n >= 3, `preflight, the brain and the judges reached the CLI (${n} calls)\n${r.out.slice(-1500)}`);
    let brain = false;
    for (let k = 1; k <= n; k++) {
      const args = await file(dir, "args", k), input = await file(dir, "stdin", k), env = await file(dir, "env", k);
      ok(!args.includes(KEY) && !input.includes(KEY) && !env.includes(KEY), `call ${k}: the real key never reaches the CLI`);
      ok(!args.includes(SUBSCRIPTION_PLACEHOLDER_KEY) && !env.includes(SUBSCRIPTION_PLACEHOLDER_KEY), `call ${k}: nor the placeholder`);
      eq((await envKeys(dir, k)).filter((x) => !ALLOWED(x)), [], `call ${k}: allowlisted env only`);
      ok(/--strict-mcp-config/.test(args) && /--setting-sources\nproject/.test(args) && /--no-session-persistence/.test(args), `call ${k}: isolation flags`);
      if (/Tools you may call:/.test(args)) brain = true; // only the brain's requests carry the product's tools
    }
    ok(brain, "the brain itself called the model (the placeholder key made the product configured)");
    eq(JSON.parse(await Deno.readTextFile(`${ROOT}/evals/career/results/${label}.json`)).ledger, "process-local", "the shared ledger was cleared");
  } finally {
    l.close();
    try { await Deno.remove(`${ROOT}/evals/career/results/${label}.json`); } catch { /* not written */ }
  }
});

Deno.test("bridge: a CLI that prints no init event is refused; an init without its newline is acted on as soon as it is whole", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  const dir = await fakeClaude(["NOINIT", "NONL:ANTHROPIC_API_KEY"]);
  await withEnv({ CI: null, GITHUB_ACTIONS: null, PATH: `${dir}:${Deno.env.get("PATH")}` }, async () => {
    await assertNode.rejects(() => cli.runCli(["-p"], "x"), /the claude CLI did not start/);
    const t0 = performance.now();
    await assertNode.rejects(() => cli.runCli(["-p"], "x"), /apiKeySource is "ANTHROPIC_API_KEY".*stopped before any model request/);
    ok(performance.now() - t0 < 2500, "refused at the init line, not when the newline or the end came");
    await new Promise((r) => setTimeout(r, 3500));
    let went = true; try { await Deno.stat(`${dir}/went-on`); } catch { went = false; }
    eq(went, false, "the child never went on past the init");
  });
});

Deno.test("bridge: a web_search request goes to the CLI with the same isolation (flags, empty folder, allowlisted env), WebSearch its only tool", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  const dir = await fakeClaude();
  await withEnv({ CI: null, GITHUB_ACTIONS: null, PATH: `${dir}:${Deno.env.get("PATH")}`, ANTHROPIC_API_KEY: "sk-ant-real-looking", CLAUDE_CODE_USE_BEDROCK: "1" }, async () => {
    const res = await cli.messages({ model: "claude-sonnet-5-5", max_tokens: 10, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }], messages: [{ role: "user", content: "who makes Deno?" }] });
    ok(res.content.some((b: any) => b.type === "server_tool_use"), JSON.stringify(res));
    const n = await calls(dir); // the preflight may have run in an earlier test: the search is the last call
    const args = (await file(dir, "args", n)).split("\n");
    eq(args[args.indexOf("--tools") + 1], "WebSearch");
    eq(args[args.indexOf("--allowedTools") + 1], "WebSearch");
    eq(args[args.indexOf("--setting-sources") + 1], "project");
    for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence", "--verbose"]) ok(args.includes(flag), flag);
    const cwd = (await file(dir, "cwd", n)).trim();
    ok(/claude-cli-empty-/.test(cwd) && cwd !== Deno.cwd(), cwd);
    eq((await file(dir, "ls", n)).trim(), "");
    eq((await envKeys(dir, n)).filter((k) => !ALLOWED(k)), []);
    ok(!(await file(dir, "env", n)).includes("sk-ant-real-looking"));
  });
});

// The mirror runner opens the response world (Postgres 16): as the other world tests, not run locally without it, a FAIL in CI.
Deno.test({ name: "end to end: run-conversation.ts --subscription preflights, then sends the product's model calls to the CLI, no key, nothing out", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("the mirror end-to-end test needs Postgres 16 in CI");
  const dir = await fakeClaude();
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmp}/conv.json`, JSON.stringify([{ id: "C1", prompt: "what should I ask in a product manager interview?" }]));
  const KEY = "sk-ant-api03-" + "M".repeat(80) + "-AA";
  const r = await run(["--import-map=tests/flow/supabase-npm.json", "evals/mirror/run-conversation.ts", "--subscription", "--conv", `${tmp}/conv.json`, "--out", `${tmp}/out.jsonl`],
    { ...PASS_ENV(), PATH: `${dir}:${Deno.env.get("PATH")}`, ANTHROPIC_API_KEY: KEY, PGBIN: pgBinDir() ?? "", TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp", USER: Deno.env.get("USER") ?? "trainee", LANG: Deno.env.get("LANG") ?? "en_US.UTF-8" });
  ok(/MIRROR-CONVERSATION subscription/.test(r.out), r.out.slice(-2000));
  ok(/external_requests=0/.test(r.out), r.out.slice(-800));
  const n = await calls(dir);
  ok(n >= 2, `the preflight and the product's model calls reached the CLI (${n})\n${r.out.slice(-1500)}`);
  ok((await file(dir, "args", 1)).includes("Reply with the word ok."), "the first CLI call is the preflight");
  const m = /model_calls=(\d+)/.exec(r.out); ok(m && Number(m[1]) >= 1 && Number(m[1]) === n - 1, `every model call went to the CLI: ${m?.[0]}, CLI calls ${n}`);
  for (let k = 1; k <= n; k++) {
    const all = (await file(dir, "args", k)) + (await file(dir, "stdin", k)) + (await file(dir, "env", k));
    ok(!all.includes(KEY) && !all.includes(SUBSCRIPTION_PLACEHOLDER_KEY), `call ${k}: no key reaches the CLI`);
  }
} });
