// Review of ag/ma-09-link-list-input (2026-11-17), finding 3: under the CAREER_BRAIN=router rollback the over-cap branch
// ("That message is longer than 4,000 characters ...") answered before the crisis reply, so crisis words beside a pasted
// list of posting links got the over-cap refusal. Crisis text must win on every brain path. At the REAL handler (handleChat)
// on real Postgres, no model key (no model is ever called), every off-machine request refused:
//   crisis words + 122 posting links, CAREER_BRAIN=router and CAREER_BRAIN unset (staged): a 988 reply, never the over-cap
//   refusal, nothing queued, no link read;
//   control: the same 122 links without the crisis words are the link turn (career_apply_queue), never the refusal either.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../../flow/handler.ts";
import { OVER_CAP_REPLY } from "../../../supabase/functions/agent-chat/_shared/chat_input.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-cr1": "7b0f8f8e-6a43-4a49-9d2c-0000000c9301", "tok-cr2": "7b0f8f8e-6a43-4a49-9d2c-0000000c9302", "tok-cr3": "7b0f8f8e-6a43-4a49-9d2c-0000000c9303" };
const LINKS = Array.from({ length: 122 }, (_, i) => `https://boards.greenhouse.io/co${i}co/jobs/${8000 + i}`).join("\n");
const CRISIS = `I don't want to live anymore. apply to all of these:\n${LINKS}`;

Deno.test({ name: "crisis words beside an over-cap link list get the crisis reply on every brain path, never the over-cap refusal", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_PLANNER", "CAREER_APPLY_LINK"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  for (const k of keys) Deno.env.delete(k);
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const h = await careerHandler(pg, PEOPLE);
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.host === "api.anthropic.com") { modelCalls++; throw new TypeError("no model in this test"); }
      if (u.origin !== new URL(SUPABASE_URL).origin) throw new TypeError(`network refused: ${u.host}`);
      return await viaDouble(req);
    }) as typeof fetch;
    const wanted = async (id: string) => pg.sql(`select count(*) from public.career_apply_wanted where user_id = '${id}'`);

    for (const [tok, brain] of [["tok-cr1", "router"], ["tok-cr2", null]] as const) {
      await t.step(`CAREER_BRAIN=${brain ?? "unset (staged)"}: the crisis reply, not the over-cap refusal`, async () => {
        if (brain) Deno.env.set("CAREER_BRAIN", brain); else Deno.env.delete("CAREER_BRAIN");
        const r = await h.chat(tok).say(CRISIS);
        eq(r.status, 200, r.reply);
        assert(/\b988\b/.test(r.reply), `a crisis reply: ${r.reply}`);
        assert(r.reply !== OVER_CAP_REPLY && !/longer than 4,000 characters/.test(r.reply), r.reply);
        eq(await wanted(PEOPLE[tok]), "0", "nothing queued");
      });
    }
    await t.step("control: the same links without the crisis words are the link turn", async () => {
      Deno.env.set("CAREER_BRAIN", "router");
      const r = await h.chat("tok-cr3").say(`apply to all of these:\n${LINKS}`);
      eq(r.status, 200, r.reply);
      eq(r.intent, "career_apply_queue", r.reply);
      assert(r.reply !== OVER_CAP_REPLY, r.reply);
    });
    eq(modelCalls, 0, "no model call on any of these turns");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) { if (saved[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, saved[k]!); }
    await pg.stop();
  }
} });
