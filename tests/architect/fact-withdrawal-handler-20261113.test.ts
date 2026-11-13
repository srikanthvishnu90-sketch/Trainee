// Review of #790, round 4 (third review, 2026-11-13), through the production handler on a real Postgres, as the review's h3.test.ts
// drives it: an eager model calls confirm_profile_fact whenever it can, so only code decides.
//   REGRESSION found: "the 3.9 gpa is outdated" with the model calling confirm_profile_fact(F-002) in the SAME turn left the GPA
//   confirmed and replied with the restore question (the question is a `show`, and the card-turn revert undid the set-aside); the
//   next "yes" got "Yes to what?". Now: that call is refused, the set-aside stands and is said, no question is shown that turn.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/fact-withdrawal-handler-20261113.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("../../evals/mirror/instinct-wa-batch1/persona.json", import.meta.url)));
const PEOPLE: Record<string, string> = { "tok-e": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0e01", "tok-r": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0e02" };
let script: (chat: any) => any = () => ({ content: "Okay." });
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("no", { status: 404 });
  return anthropicWire(req, async (body: any) => { const m = script(body);
    return new Response(JSON.stringify({ id: "f", model: body.model, choices: [{ index: 0, message: { role: "assistant", ...m }, finish_reason: m.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } }); });
};
const say = (t: string) => () => ({ content: t });
const eager = (id: string, then: string) => (body: any) => { const msgs = body.messages ?? [], lastUser = msgs.map((m: any) => m.role).lastIndexOf("user"), toolAfter = msgs.slice(lastUser + 1).some((m: any) => m.role === "tool");
  return toolAfter || !(body.tools ?? []).some((t: any) => t.function?.name === "confirm_profile_fact") ? { content: then } : { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "confirm_profile_fact", arguments: JSON.stringify({ id }) } }] }; };
const LINE = "Set aside, not deleted (no longer used until you say it's right again): GPA: 3.9";
const QUESTION = 'Is this right again: "GPA: 3.9"? Reply yes to put it back on your record, or no to leave it set aside.';

Deno.test({ name: "set-aside and restore through the real handler: the set-aside turn never asks to restore; code's question, then a plain yes, restores", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg(), realFetch = globalThis.fetch;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}'); insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-not-a-key"); globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const find = (o: any): any => { if (!o || typeof o !== "object") return null; if (o.text === "GPA: 3.9" && o.id) return o; for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = find(v); if (r) return r; } return null; };
    const gpa = async (who: string) => { const s = String(await pg.sql(`select coalesce(json_agg(state)::text,'[]') from public.agent_flow_state where user_id = '${PEOPLE[who]}'`)); const f = find(JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1))); return [f?.status, !!f?.withdrawn_by_owner]; };
    const chats: Record<string, any> = {};
    const turn = async (who: string, m: string, s: (b: any) => any) => { script = s; return await (chats[who] ??= handler!.chat(who)).say(m); };
    // The eager model on the set-aside turn itself.
    await turn("tok-e", PERSONA.setup[0], say("Okay.")); await turn("tok-e", PERSONA.setup[1], say("Okay."));
    const e1 = await turn("tok-e", "the 3.9 gpa is outdated", eager("F-002", "Understood, thanks for letting me know about that."));
    assertNode.deepStrictEqual([String(e1.reply), e1.body?.meta?.restore_ask, await gpa("tok-e")], [`${LINE}\n\nUnderstood, thanks for letting me know about that.`, undefined, ["draft", true]]);
    const e2 = await turn("tok-e", "actually can you put my gpa back", eager("F-002", "x"));
    assertNode.deepStrictEqual([String(e2.reply), e2.body?.meta?.restore_ask, await gpa("tok-e")], [QUESTION, { fact_id: "F-002" }, ["draft", true]]);
    const e3 = await turn("tok-e", "yes", eager("F-002", "It is back on your record."));
    assertNode.deepStrictEqual([String(e3.reply), await gpa("tok-e")], ["It is back on your record.", ["confirmed", false]]);
    // A no leaves it set aside, and the yes after that answers nothing.
    await turn("tok-r", PERSONA.setup[0], say("Okay.")); await turn("tok-r", PERSONA.setup[1], say("Okay."));
    await turn("tok-r", "the 3.9 gpa is outdated", say("Understood, thanks for letting me know about that."));
    await turn("tok-r", "actually can you put my gpa back", eager("F-002", "x"));
    await turn("tok-r", "no", say("It stays set aside."));
    assertNode.deepStrictEqual(await gpa("tok-r"), ["draft", true]);
    const late = await turn("tok-r", "yes", eager("F-002", "It is back."));
    assertNode.deepStrictEqual([await gpa("tok-r"), /back on your record|It is back/.test(String(late.reply))], [["draft", true], false], String(late.reply));
  } finally { handler?.restore(); globalThis.fetch = realFetch; await pg.stop(); }
} });
