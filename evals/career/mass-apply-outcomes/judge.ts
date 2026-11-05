// DT-1 optional model-judged mode, OFF by default (run.ts --judge). It never changes the score: it gives a second opinion
// on each answer the deterministic grader called wrong or contested, so a gold label can be challenged.
// Owner rule (Claude billing, subscription only): the model is reached ONLY through the `claude` CLI, headless, with
// ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN removed from the child's environment (with either set the CLI bills the API).
// Before any call, a preflight refuses the run if the CLI's own settings could supply a key (apiKeyHelper, a key in a settings
// env, a stored console key). Every call is then verified: the stream's init event must report apiKeySource "none", or the
// answer is discarded and the run stops. Nothing here sends a key.
import personasJson from "./personas.json" with { type: "json" };

export const STRIPPED = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

// The child's environment: the parent's, without the two variables that switch the CLI to API billing.
export function childEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!STRIPPED.includes(k)) out[k] = v;
  return out;
}
export const CLAUDE_ARGS = ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config"];

// The stream's verdict, only when the init event proves subscription billing.
export function readStream(stdout: string): { text: string } {
  const events = stdout.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e: any) => e.type === "system" && e.subtype === "init");
  if (!init || init.apiKeySource !== "none") throw new Error(`refused: the claude CLI did not report subscription billing (apiKeySource ${JSON.stringify(init?.apiKeySource)})`);
  const res = events.findLast((e: any) => e.type === "result");
  return { text: String(res?.result ?? "") };
}

// Preflight, before any call: the CLI can also bill the API through its own settings (an apiKeyHelper, a key in a settings
// file's env, or a stored console key). Any of these, or a settings file that cannot be parsed, refuses the whole judge
// run, so not even one call is made on API billing. `files` maps each settings path to its text (absent files omitted).
export function settingsRefusal(files: Record<string, string>): string | null {
  for (const [path, text] of Object.entries(files)) {
    let j: any;
    try { j = JSON.parse(text); } catch { return `${path} is unreadable; refusing (fail closed)`; }
    if (j && typeof j === "object") {
      if (j.apiKeyHelper) return `${path} sets apiKeyHelper`;
      if (j.primaryApiKey) return `${path} holds primaryApiKey`;
      for (const k of STRIPPED) if (j.env && Object.hasOwn(j.env, k)) return `${path} sets ${k} in env`;
    }
  }
  return null;
}
export function settingsFiles(home: string, cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [`${home}/.claude/settings.json`, `${home}/.claude/settings.local.json`, `${home}/.claude.json`,
    `${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`]) {
    try { out[p] = Deno.readTextFileSync(p); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) out[p] = "{unreadable"; }
  }
  return out;
}

async function ask(prompt: string): Promise<string> {
  const cmd = new Deno.Command("claude", { args: CLAUDE_ARGS, env: childEnv(Deno.env.toObject()), clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(prompt));
  await w.close();
  const out = await child.output();
  return readStream(new TextDecoder().decode(out.stdout)).text;
}

export async function judgeAll(apps: any[], o: { max: number }) {
  const refusal = settingsRefusal(settingsFiles(Deno.env.get("HOME") ?? "", Deno.cwd()));
  if (refusal) throw new Error(`judge refused before any call: ${refusal} (the claude CLI could bill the API; subscription only)`);
  const personas: any = (personasJson as any).personas;
  const items = apps.filter((a) => a.kind !== "card").flatMap((a) => a.fields.filter((f: any) => f.verdict === "wrong" || f.verdict === "contested_fill").map((f: any) => ({ a, f }))).slice(0, o.max);
  const out: { key: string; label: string; shown: string; verdict: string; why: string }[] = [];
  for (const { a, f } of items) {
    const prompt = [
      "You check one answer on a job application form. Facts the applicant confirmed (nothing else is known about them):",
      JSON.stringify(personas[a.persona].confirmed),
      `Employer: ${a.company}. Question: ${JSON.stringify(f.label)}. Answer that would be sent: ${JSON.stringify(f.shown)}.`,
      "Is that answer true and supported by the confirmed facts alone? Reply with one JSON object only: {\"verdict\":\"correct\"|\"wrong\"|\"unsure\",\"why\":\"<one short sentence>\"}",
    ].join("\n");
    let verdict = "unsure", why = "";
    const text = await ask(prompt);
    try { const j = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "{}"); verdict = String(j.verdict ?? "unsure"); why = String(j.why ?? ""); } catch { why = text.slice(0, 120); }
    out.push({ key: `${a.key}#${f.i}`, label: f.label.slice(0, 80), shown: String(f.shown).slice(0, 60), verdict, why });
  }
  return out;
}
