// Claude-only (owner, 2026-11-02 18:38 CT): no OpenAI call anywhere, voice off. This scan FAILS if any executable code under
// supabase/functions/, workers/ or scripts/ names an OpenAI endpoint (api.openai.com), reads an OPENAI_* variable, or names a
// `gpt-` model id. Comments, docs and data (.md, .json, .csv, fixtures, migrations, the job-board rows in router_core*.js) are not
// executable code and are not scanned. The gateway itself refuses a non-Claude model id (providerFor).
//
// ALLOWED is the explicit, short list of files that still name OpenAI because ANOTHER work package owns them (empty now: #444 cleaned the launch scripts). Each entry says which
// package removes it; that package deletes its line here in the same PR (an entry whose file no longer matches FAILS this test, so
// the list cannot rot, and nothing can be added to it silently).
import assertNode from "node:assert/strict";
import { providerFor } from "../../supabase/functions/_shared/model_gateway.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

export const ALLOWED: Record<string, string> = {
};

const SCANNED = ["supabase/functions", "workers", "scripts", "api", "site", "src"];
const OPENAI = /api\.openai\.com|\bOPENAI_[A-Z_]+|\bgpt-[a-z0-9]/i;
const EXT = /\.(ts|tsx|js|mjs|cjs|sh|py|yml|yaml)$/;
const SKIP_FILE = /(^|\/)router_core[^/]*\.js$/; // generated bundle: job-board rows name companies, not providers
const SKIP_DIR = new Set(["node_modules", ".git", "fixtures", "data"]);

// The executable text of a source file: whole-line comments and trailing comments removed.
export function executable(text: string, path: string): string[] {
  const hash = /\.(sh|py|yml|yaml)$/.test(path);
  let inBlock = false;
  return text.split("\n").map((line) => {
    let l = line;
    if (!hash && /^\s*\*/.test(l)) return ""; // a continuation line of a block comment
    if (inBlock) { const e = l.indexOf("*/"); if (e < 0) return ""; inBlock = false; l = l.slice(e + 2); }
    for (;;) { const s = l.indexOf("/*"); if (s < 0 || hash) break; const e = l.indexOf("*/", s + 2); if (e < 0) { inBlock = true; l = l.slice(0, s); break; } l = l.slice(0, s) + l.slice(e + 2); }
    l = l.replace(/(^|\s)\/\/.*$/, "$1");
    if (hash) l = l.replace(/(^|\s)#.*$/, "$1");
    return l;
  });
}
export function offenders(files: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, text] of Object.entries(files)) {
    const hits = executable(text, path).map((l, i) => (OPENAI.test(l) ? `${i + 1}: ${l.trim().slice(0, 100)}` : "")).filter(Boolean);
    if (hits.length) out[path] = hits;
  }
  return out;
}
async function tree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    let entries: Deno.DirEntry[] = []; try { entries = [...Deno.readDirSync(`${ROOT}/${dir}`)]; } catch (_) { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory) { if (!SKIP_DIR.has(e.name)) await walk(rel); }
      else if (EXT.test(e.name) && !SKIP_FILE.test(e.name)) out[rel] = await Deno.readTextFile(`${ROOT}/${rel}`);
    }
  };
  for (const d of SCANNED) await walk(d);
  return out;
}

Deno.test("claude-only: no OpenAI endpoint, OPENAI_* variable or gpt- model id in executable code under supabase/functions, workers, scripts, api, site or src (short, explicit allow-list)", async () => {
  const files = await tree();
  assert(Object.keys(files).length > 300, `the scan really read the tree (${Object.keys(files).length} files)`);
  const found = offenders(files), unlisted = Object.keys(found).filter((p) => !ALLOWED[p]);
  eq(unlisted.map((p) => `${p} -> ${found[p].join(" | ")}`), [], "OpenAI named in executable code outside the allow-list");
  const stale = Object.keys(ALLOWED).filter((p) => !found[p]);
  eq(stale, [], "an allow-list entry whose file no longer names OpenAI must be deleted from ALLOWED");
  assert(Object.keys(ALLOWED).length <= 12, "the allow-list stays short");
  for (const core of ["supabase/functions/_shared/model_gateway.ts", "supabase/functions/_shared/model_budget.ts", "supabase/functions/_shared/model_health.ts", "supabase/functions/agent-chat/release_model.ts"])
    assert(files[core] && !found[core], `${core} is clean`);
});

Deno.test("claude-only: the scan notices each shape, ignores comments and data, and the allow-list is not a hole", () => {
  for (const bad of ['await fetch("https://api.openai.com/v1/chat/completions", {})', "const k = Deno.env.get('OPENAI_API_KEY');", 'const model = "gpt-5-mini";', "const m = 'gpt-4.1-mini'", "model: `gpt-realtime`", 'export OPENAI_MODEL=x'])
    assert(Object.keys(offenders({ "supabase/functions/x/index.ts": bad })).length === 1, `caught: ${bad}`);
  eq(offenders({ "supabase/functions/x/index.ts": "// api.openai.com, OPENAI_API_KEY and gpt-5 in a comment\n/* gpt-4 in a block\n   OPENAI_MODEL */ const a = 1; // gpt-5 trailing\n * gpt-3" }), {}, "comments are ignored");
  eq(offenders({ "scripts/x.sh": "# OPENAI_API_KEY is only a comment\nexport OPENAI_API_KEY=1" }), { "scripts/x.sh": ["2: export OPENAI_API_KEY=1"] }, "a shell comment is ignored, the export is not");
  eq(offenders({ "supabase/functions/x.ts": "const s = 'chatgpt-style sources'; const t = 'ChatGPT';" }), {}, "chatgpt is not a model id");
  eq(Object.keys(ALLOWED).filter((p) => !/^(supabase\/functions|workers|scripts|api|site|src)\//.test(p)), [], "allowed paths are inside the scanned directories");
});

Deno.test("claude-only: providerFor refuses gpt-5-mini and every other non-Claude id, and accepts the two Claude models", () => {
  let err: any = null; try { providerFor("gpt-5-mini"); } catch (e) { err = e; }
  assert(err && err.type === "not_configured" && /Claude models only/.test(err.detail), String(err));
  for (const id of ["gpt-5", "gpt-4.1-mini", "gpt-6-luna", "o3", "text-embedding-3-small", "whisper-1", "", "claude"]) {
    let e2: any = null; try { providerFor(id); } catch (e) { e2 = e; }
    assert(e2 && e2.type === "not_configured", `${id || "(empty)"} is refused`);
  }
  eq([providerFor("claude-haiku-5-5"), providerFor("claude-sonnet-5-5")], ["anthropic", "anthropic"]);
});

Deno.test("claude-only: a rejected CAREER_MODEL, CAREER_REPLY_MODEL or MODEL_PROVIDER is said once per boot on the error log and Sonnet 5.5 is used (D-046)", async () => {
  const { careerModel } = await import("../../supabase/functions/agent-chat/release_model.ts");
  const { modelConfig, readerModel, resetIgnoredWarnings } = await import("../../supabase/functions/_shared/model_gateway.ts");
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  const lines: string[] = [], loud = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    resetIgnoredWarnings();
    eq(careerModel(env({ ANTHROPIC_API_KEY: "a", CAREER_REPLY_MODEL: "gpt-5-mini" })), "claude-sonnet-5-5");
    careerModel(env({ ANTHROPIC_API_KEY: "a", CAREER_REPLY_MODEL: "gpt-5-mini" }));
    eq(readerModel(env({ CAREER_MODEL: "gpt-4.1-mini" })), "claude-sonnet-5-5");
    readerModel(env({ CAREER_MODEL: "gpt-4.1-mini" }));
    eq(modelConfig(env({ MODEL_PROVIDER: "openai" })).model, "claude-sonnet-5-5");
    modelConfig(env({ MODEL_PROVIDER: "openai" }));
    eq(lines.length, 3, "once per variable, however often it is read: " + lines.join(" | "));
    for (const name of ["CAREER_REPLY_MODEL", "CAREER_MODEL", "MODEL_PROVIDER"]) assert(lines.some((l) => l.includes(`${name}=`) && l.includes("claude-sonnet-5-5")), name);
    // Honoured or empty values say nothing.
    resetIgnoredWarnings(); lines.length = 0;
    careerModel(env({ ANTHROPIC_API_KEY: "a", CAREER_REPLY_MODEL: "claude-sonnet-5-5" }));
    careerModel(env({})); readerModel(env({ CAREER_MODEL: "claude-sonnet-5-5" })); modelConfig(env({ MODEL_PROVIDER: "anthropic" })); modelConfig(env({}));
    eq(lines, [], "nothing to say");
  } finally { console.error = loud; resetIgnoredWarnings(); }
});
