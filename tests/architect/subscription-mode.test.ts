// D-089 (owner, 2026-11-16: "yes" to the local subscription mode): evals/career/run.ts --subscription answers every model
// call with the `claude` CLI on the owner's subscription (evals/subscription/claude_cli.ts). Review of #853:
//   B3  the run measures the committed code: any environment variable that changes the brain, its model or effort, the
//       gateway, the judges or a switch the reply path reads refuses the run, before any CLI call; the result records the rule.
//   the bridge refuses CI whoever imports it, strips every provider/billing switch from the child, routes only the Messages
//   endpoint itself (not count_tokens or batches), and refuses EVERY call whose own init event is not apiKeySource "none".
// No real CLI and no model: a fake `claude` on PATH prints the CLI's stream-json events.
// Run: deno test -A --no-check tests/architect/subscription-mode.test.ts
import assertNode from "node:assert/strict";
import { BRAIN_ENV_NAMES, brainEnvCheck, brainEnvOverrides } from "../../evals/career/run.ts";
import { RELEASE_FLAGS } from "../../supabase/functions/agent-chat/release_config.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("B3: every variable that changes the brain, the gateway or the judges is an override; unrelated and removed keys are not", () => {
  const named = ["CAREER_BRAIN_ROUTER_INTENTS", "CAREER_BRAIN", "CAREER_MODEL", "MODEL_PROVIDER", "ANTHROPIC_EFFORT", "CAREER_REPLY_MODEL",
    "ANTHROPIC_MODEL", "ANTHROPIC_ROUTER_MODEL", "ANTHROPIC_BASE_URL", "EVAL_JUDGE_MODEL", "EVAL_JUDGE_MODEL_2", "EVAL_SEALED_PATH", "CAREER_REPLY_WRITER",
    "CAREER_JUDGE", "CAREER_JUDGE_N", "CAREER_PLANNER", "MODEL_BUDGET_PAUSED", "APPLY_VM", Object.keys(RELEASE_FLAGS)[0]];
  for (const k of named) eq(brainEnvOverrides({ [k]: "x" }), [k], k);
  eq(brainEnvOverrides({ CAREER_MODEL: "" }), ["CAREER_MODEL"], "set but empty still counts");
  eq(brainEnvOverrides({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", EVAL_LEDGER: "x", CLAUDECODE: "1" }), []);
  for (const k of Object.keys(RELEASE_FLAGS)) ok(BRAIN_ENV_NAMES.includes(k), `release flag ${k} is checked`);
  const c = brainEnvCheck(); ok(c.prefixes.includes("CAREER_") && c.names.length > 0 && c.removed.includes("ANTHROPIC_API_KEY"));
});

async function fakeClaude(dir: string, sources: string[]): Promise<string> {
  // Each call takes the next apiKeySource from the list and answers {"content":[{"type":"text","text":"ok"}]}.
  await Deno.writeTextFile(`${dir}/sources`, sources.join("\n") + "\n");
  await Deno.writeTextFile(`${dir}/claude`, `#!/bin/sh
cat > /dev/null
n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"
env > "${dir}/env.$n"
src=$(sed -n "\${n}p" "${dir}/sources")
echo '{"type":"system","subtype":"init","apiKeySource":"'$src'"}'
echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"content":[{"type":"text","text":"ok"}]},"usage":{"input_tokens":1,"output_tokens":1}}'
`);
  await Deno.chmod(`${dir}/claude`, 0o755);
  return dir;
}

Deno.test("B3: run.ts --subscription refuses an override before any CLI call (exit 2, names the variable)", async () => {
  const dir = await fakeClaude(await Deno.makeTempDir(), ["none", "none"]);
  const env: Record<string, string> = { PATH: `${dir}:${Deno.env.get("PATH")}`, HOME: Deno.env.get("HOME") ?? "/tmp", CAREER_MODEL: "claude-haiku-4-5", MODEL_PROVIDER: "openai" };
  const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", "evals/career/run.ts", "--subscription", "--brain", "staged", "--set", "dev", "--label", "b3-refusal"], cwd: ROOT, env, clearEnv: true, stdout: "piped", stderr: "piped" }).output();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  eq(r.code, 2, out);
  ok(/NOT RUN: --subscription measures the committed code, but the environment sets CAREER_MODEL, MODEL_PROVIDER/.test(out), out);
  let calls = 0; try { calls = Number(await Deno.readTextFile(`${dir}/n`)); } catch { /* never called */ }
  eq(calls, 0, "no CLI call was made");
});

Deno.test("bridge: only the Messages endpoint itself goes to the CLI; the child never holds a key or a provider switch", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  ok(cli.isMessagesUrl("https://api.anthropic.com/v1/messages"));
  ok(cli.isMessagesUrl("https://api.anthropic.com/v1/messages?beta=true"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/count_tokens"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/batches"));
  ok(!cli.isMessagesUrl("https://api.anthropic.com/v1/messages/batches/msgbatch_1/results"));
  const e = cli.childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1" });
  eq(e, { PATH: "/bin" });
});

Deno.test("bridge: refuses in CI whoever calls it, and refuses every call whose own init is not apiKeySource none", async () => {
  const cli = await import("../../evals/subscription/claude_cli.ts");
  const dir = await fakeClaude(await Deno.makeTempDir(), ["none", "none", "ANTHROPIC_API_KEY"]);
  const saved = { PATH: Deno.env.get("PATH") ?? "", CI: Deno.env.get("CI") };
  const body = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  try {
    Deno.env.set("CI", "true");
    await assertNode.rejects(() => cli.preflight(), /never runs in CI/);
    await assertNode.rejects(() => cli.messages(body), /never runs in CI/);
    Deno.env.delete("CI");
    Deno.env.set("PATH", `${dir}:${saved.PATH}`);
    Deno.env.set("CLAUDE_CODE_USE_FOUNDRY", "1");
    const res = await cli.messages(body); // call 1: preflight, call 2: the request
    eq(res.content, [{ type: "text", text: "ok" }]);
    ok(!/CLAUDE_CODE_USE_FOUNDRY/.test(await Deno.readTextFile(`${dir}/env.2`)), "the child never sees CLAUDE_CODE_USE_FOUNDRY");
    await assertNode.rejects(() => cli.messages(body), /apiKeySource is "ANTHROPIC_API_KEY", not "none"/); // call 3: refused
    eq(cli.stats.apiKeySource, "ANTHROPIC_API_KEY", "the refused source stays recorded");
  } finally {
    Deno.env.set("PATH", saved.PATH); Deno.env.delete("CLAUDE_CODE_USE_FOUNDRY");
    if (saved.CI === undefined) Deno.env.delete("CI"); else Deno.env.set("CI", saved.CI);
  }
});
