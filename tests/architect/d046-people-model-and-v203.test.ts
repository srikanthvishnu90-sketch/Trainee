// D-046 follow-up (architect, 2026-11-09):
//   (1) people search: CAREER_PEOPLE_SEARCH_MODEL can never pick a model but claude-sonnet-5-5; a stale value is ignored with one
//       log line, and the config goes through assertProductModel, before web search can ever be switched on.
//   (2) the Upmore-era agent-chat v203 copy is not a Trainee rollback: on a project with Trainee's secrets it refuses every request.
import assertNode from "node:assert/strict";
import { DEFAULT_SEARCH_MODEL, providerConfig } from "../../supabase/functions/_shared/career_people_provider.ts";
import { resetIgnoredWarnings, TRAINEE_MODEL } from "../../supabase/functions/_shared/model_gateway.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../../", import.meta.url);
const env = (v: Record<string, string>) => (k: string) => v[k];
const code = async (p: string) => (await Deno.readTextFile(new URL(p, ROOT))).replace(/^\s*\/\/.*$/gm, "");

Deno.test("D-046 people search: the model is Sonnet 5.5 whatever CAREER_PEOPLE_SEARCH_MODEL says; a stale value is said once", () => {
  eq(DEFAULT_SEARCH_MODEL, TRAINEE_MODEL);
  const lines: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    resetIgnoredWarnings();
    for (const v of ["claude-haiku-5-5", "gpt-4.1-mini", "claude-opus-5-5", "x"]) {
      for (const sw of ["on", "off"]) {
        eq(providerConfig(env({ CAREER_PEOPLE_SEARCH: sw, ANTHROPIC_API_KEY: "sk-test-not-real", CAREER_PEOPLE_SEARCH_MODEL: v })).model, TRAINEE_MODEL, `${v} (${sw})`);
      }
    }
    eq(lines.filter((l) => l.includes("CAREER_PEOPLE_SEARCH_MODEL=")).length, 1, `one log line per boot: ${lines}`);
    resetIgnoredWarnings(); lines.length = 0;
    eq(providerConfig(env({ CAREER_PEOPLE_SEARCH_MODEL: TRAINEE_MODEL })).model, TRAINEE_MODEL);
    eq(providerConfig(env({})).model, TRAINEE_MODEL);
    eq(lines, [], "Sonnet named, or nothing named: no log line");
  } finally { console.error = orig; resetIgnoredWarnings(); }
});

Deno.test("D-046 people search: providerConfig runs the product-model guard and reads no model of its own", async () => {
  const src = await code("supabase/functions/_shared/career_people_provider.ts");
  assert(/const model = assertProductModel\(\{ \.\.\.gw, model: DEFAULT_SEARCH_MODEL \}\)\.model;/.test(src), "the config's model passes assertProductModel");
  assert(!/model:\s*\(env\("CAREER_PEOPLE_SEARCH_MODEL"\)/.test(src), "CAREER_PEOPLE_SEARCH_MODEL is never the model");
});

Deno.test("D-046 v203: the Upmore-era agent-chat refuses every request on a project with Trainee's secrets, before auth or a model call", async () => {
  const src = await code("scripts/launch/rollback/agent-chat-v203/index.ts");
  assert(/const TRAINEE_PROJECT = \["TRAINEE_INBOUND_SECRET", "TRAINEE_DELIVER_SECRET", "CAREER_INGEST_SECRET", "CAREER_PROACTIVE_SECRET"\]\.some\(\(k\) => !!Deno\.env\.get\(k\)\);/.test(src), "Trainee's project secrets are the signal");
  const body = src.slice(src.indexOf("serve(async (req) => {"));
  const refuse = body.indexOf("if (TRAINEE_PROJECT) return json(cors, { error: \"not_a_trainee_rollback\"");
  assert(refuse > 0, "the refusal is in the handler");
  for (const later of ["Authorization", "ANTHROPIC_URL", "fetch("]) assert(body.indexOf(later) > refuse, `the refusal comes before ${later}`);
  assert(/503\);/.test(body.slice(refuse, refuse + 300)), "503");
  const doc = await Deno.readTextFile(new URL("docs/launch/TRAINEE-GO-LIVE.md", ROOT));
  assert(/Never `scripts\/launch\/rollback\/agent-chat-v203\/`/.test(doc) && /not a Trainee rollback/.test(doc), "the go-live doc says it is not a Trainee rollback");
});
