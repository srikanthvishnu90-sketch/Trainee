// PERSONALIZED OUTREACH (2026-10-31) for the older outreach suites. Every new outreach draft now goes through the
// personalization engine: a recipient with only a title and firm on record gets ONE question, never a generic email, and a
// draft must reference something sourced about them. Suites written before that, whose point is something else (blocked
// addresses, approvals, the send rail, signatures), give each recipient one sourced fact (what the person told Trainee) and
// let their scripted model write from the engine's payload. Their other assertions are unchanged.
import { fakeWriter } from "../../evals/outreach-personalize/fixtures.ts";
import type { RecipientFact } from "../../supabase/functions/_shared/career_outreach_personalize.ts";

export const SEED_AT = "2026-10-20T15:00:00.000Z";
// One sourced fact about a contact, as the person would state it in chat (career_networking.ts saveFacts: user_stated).
export const statedFact = (topic = "data pipelines"): RecipientFact[] =>
  [{ id: "said:seed", kind: "work", work_kind: "talk", text: `Spoke at the TEST meetup about ${topic}`, anchor: `the TEST meetup talk about ${topic}`, source_kind: "user_stated", source_url: null, retrieved_at: SEED_AT }];
// The person key the contacts use for an address (career_networking.ts personKey).
export const keyOfEmail = (email: string) => `e:${email.trim().toLowerCase()}`;
// In memory: the fact on each address.
export async function seedFacts(store: { addRecipientFacts?: (u: string, k: string, f: RecipientFact[]) => Promise<number> }, userId: string, emails: string[]) {
  for (const e of emails) await store.addRecipientFacts!(userId, keyOfEmail(e), statedFact());
}
// On Postgres: the same rows career_networking.ts writes (career_watch_kv 'career:rfacts:<person key>').
export const seedFactsSql = (userId: string, emails: string[]) =>
  emails.map((e) => `insert into public.career_watch_kv (user_id, key, value) values ('${userId}', 'career:rfacts:${keyOfEmail(e)}', '${JSON.stringify({ facts: statedFact() }).replace(/'/g, "''")}'::jsonb) on conflict (user_id, key) do update set value = excluded.value;`).join("\n");
// A scripted model that writes from the engine's payload when it is given one, and otherwise as the suite's own model did
// (a follow-up, an intro request to someone the person knows). `extra` lets a suite keep its invented-claim case.
export function engineAware(old: (p: any) => Promise<any>, extra?: (first: string) => string) {
  const w = fakeWriter();
  return async (p: any) => {
    const t = String(p?.messages?.[0]?.content ?? "");
    if (!/DATA \(JSON/.test(t)) return await old(p);
    const out: any = await w(p);
    if (extra) {
      const first = /"first":"([^"]*)"/.exec(t)?.[1] ?? "";
      const add = extra(first);
      if (add) out.content[0].text = out.content[0].text.replace(/(\n\nHi [^\n]+\n\n)/, `$1${add} `);
    }
    return out;
  };
}
// The same, as an OpenAI chat-completions response, for suites that fake the model at its URL.
export async function openAIFrom(body: any, write: (p: any) => Promise<any>): Promise<Response> {
  const user = (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const out: any = await write({ messages: [{ role: "user", content: user }] });
  return new Response(JSON.stringify({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: out.content[0].text }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 80 } }), { status: 200, headers: { "content-type": "application/json" } });
}
// Every recipient this store is asked about carries one sourced fact (for suites whose recipients come from many places).
export function everyoneKnown<S extends { recipientFacts?: unknown }>(store: S): S {
  (store as any).recipientFacts = async (_u: string, keys: string[]) => new Map(keys.map((k) => [k, statedFact()]));
  return store;
}
// For a suite's fake at the OpenAI URL: the engine's payload answered from it (null for any other payload, which the
// suite's own fake answers as before).
export function personalOpenAI(body: any, extra?: (first: string) => string): Promise<Response> | null {
  const user = (body?.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (!/DATA \(JSON/.test(user)) return null;
  return openAIFrom(body, engineAware(async () => null, extra));
}
// On Postgres, by person key (an address "e:<address>", or a name at a firm "n:<name>@<firm>" as career_networking.ts keys it).
export const seedKeysSql = (userId: string, keys: string[]) =>
  keys.map((k) => `insert into public.career_watch_kv (user_id, key, value) values ('${userId}', 'career:rfacts:${k.replace(/'/g, "''")}', '${JSON.stringify({ facts: statedFact() }).replace(/'/g, "''")}'::jsonb) on conflict (user_id, key) do update set value = excluded.value;`).join("\n");
