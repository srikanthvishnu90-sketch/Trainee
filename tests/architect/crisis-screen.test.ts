// #354 safety re-review (2026-11-01): the crisis screen's second layer, OpenAI moderation, beside the deterministic list.
// Fail-safe: either layer flagging gives the crisis reply; moderation erroring or timing out leaves the list's verdict
// and never blocks the turn. A fake moderation client stands in for OpenAI: nothing here leaves the process.
import assertNode from "node:assert/strict";
import { classifierFromEnv, CLASSIFIER_PROMPT, CRISIS_SCREEN_MARKER, crisisScreen, gatewayModeration, type Moderate, moderationFromEnv, moderationReleaseOn, PRODUCTION_CRISIS_MODERATION, readModeration } from "../../supabase/functions/_shared/career_crisis_screen.ts";
import { moderate, MODERATION_MODEL } from "../../supabase/functions/_shared/model_gateway.ts";
import { SAFETY_REPLY, trustTurn } from "../../supabase/functions/_shared/career_trust_turn.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
// A message the list does not catch (moderation's job): an oblique one.
const OBLIQUE = "i gave away my things and wrote the letters, tonight is the night";
const CAREER = "find me data analyst jobs in chicago";
const flag = (cats = ["self-harm/intent"]): Moderate => () => Promise.resolve({ flagged: true, categories: cats });
const clear: Moderate = () => Promise.resolve({ flagged: false, categories: [] });
const quiet = () => { const lines: string[] = []; return { lines, log: (l: string) => lines.push(l) }; };

Deno.test("moderation flags what the list missed: the crisis reply wins", async () => {
  const v = await crisisScreen(OBLIQUE, flag());
  eq(v, { distress: true, rules: false, moderation: "flagged", classifier: "off", categories: ["self-harm/intent"] });
  const a = await trustTurn({ message: OBLIQUE, distress: v.distress, deps: { connections: () => Promise.resolve([]), stored: () => Promise.resolve(null) } });
  eq(a?.intent, "safety_support");
  eq(a?.reply, SAFETY_REPLY);
});

Deno.test("no flag from moderation and none from the list: no crisis", async () => {
  eq(await crisisScreen(CAREER, clear), { distress: false, rules: false, moderation: "clear", classifier: "off", categories: [] });
});

Deno.test("the list's hit stands without waiting on moderation, even if moderation says clear or hangs", async () => {
  let called = 0;
  const hang: Moderate = () => { called++; return new Promise(() => {}); };
  const started = Date.now();
  const v = await crisisScreen("kms", hang, { timeoutMs: 5000 });
  eq(v.distress, true); eq(v.rules, true); eq(v.moderation, "skipped");
  assert(Date.now() - started < 200, "answered at once"); eq(called, 0, "no call needed");
  eq((await crisisScreen("i want to die", clear)).distress, true, "a clear moderation never overrides the list");
});

Deno.test("a moderation timeout falls back to the list within the cap, logs it, and aborts the call", async () => {
  let aborted = false;
  const hang: Moderate = (_t, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }));
  const q = quiet();
  const started = Date.now();
  const v = await crisisScreen(CAREER, hang, { timeoutMs: 50, log: q.log });
  eq(v, { distress: false, rules: false, moderation: "timeout", classifier: "off", categories: [] });
  assert(Date.now() - started < 1000, `within the cap: ${Date.now() - started} ms`);
  assert(aborted, "the call was aborted");
  eq(q.lines.length, 1); assert(/timed out/.test(q.lines[0]) && !q.lines[0].includes(CAREER), "logged, never the text");
});

Deno.test("a moderation error (thrown, rejected or HTTP) falls back to the list and logs", async () => {
  for (const m of [(() => { throw new Error("boom"); }) as Moderate, (() => Promise.reject(new Error("network"))) as Moderate,
    gatewayModeration((t, o) => moderate(t, { ...o, env: { get: (k) => (k === "OPENAI_API_KEY" ? "k" : undefined) }, request: () => Promise.resolve(new Response("no", { status: 500 })) }))]) {
    const q = quiet();
    eq(await crisisScreen(CAREER, m, { log: q.log }), { distress: false, rules: false, moderation: "error", classifier: "off", categories: [] });
    eq(q.lines.length, 1); assert(/failed/.test(q.lines[0]), q.lines[0]);
  }
  // an error never hides the list's own hit
  eq((await crisisScreen("i took too many pills", () => Promise.reject(new Error("x")))).distress, true);
});

Deno.test("the gateway's moderation door: /v1/moderations only, the key from the environment, the kill switch, never the text in errors", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  const ok = (cats: Record<string, boolean>) => (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! });
    return Promise.resolve(Response.json({ results: [{ flagged: true, categories: cats }] }));
  };
  const ctl = new AbortController();
  const body = await moderate("x", { env: env({ OPENAI_API_KEY: "sk-test" }), request: ok({ "self-harm/intent": true }) as typeof fetch, signal: ctl.signal });
  eq(seen[0].url, "https://api.openai.com/v1/moderations");
  eq(JSON.parse(String(seen[0].init.body)), { model: MODERATION_MODEL, input: "x" });
  eq((seen[0].init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert(seen[0].init.signal instanceof AbortSignal, "the call carries a deadline");
  eq(readModeration(body), { flagged: true, categories: ["self-harm/intent"] });
  // only the self-harm categories are read
  eq(readModeration({ results: [{ categories: { "self-harm": false, "self-harm/intent": true, "self-harm/instructions": true, violence: true } }] }), { flagged: true, categories: ["self-harm/intent", "self-harm/instructions"] });
  eq(readModeration({ results: [{ categories: { violence: true, harassment: true } }] }), { flagged: false, categories: [] }, "another category is not this screen's business");
  assertNode.throws(() => readModeration({}), /no result/);
  // no key: not configured, nothing sent; the kill switch: paused, nothing sent
  const n = seen.length;
  await assertNode.rejects(() => moderate("x", { env: env({}), request: ok({}) as typeof fetch }), /not configured/);
  await assertNode.rejects(() => moderate("x", { env: env({ OPENAI_API_KEY: "k", MODEL_BUDGET_PAUSED: "on" }), request: ok({}) as typeof fetch }), /PAUSED/);
  eq(seen.length, n, "nothing sent without a key or with the kill switch on");
  // an HTTP error never carries the text
  await assertNode.rejects(() => moderate("secret words", { env: env({ OPENAI_API_KEY: "k" }), request: () => Promise.resolve(new Response("x", { status: 429 })) }), (e: Error) => /429/.test(e.message) && !/secret words/.test(e.message));
  // the deadline: a hang is cut at timeoutMs
  const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init!.signal!.reason)));
  const t0 = Date.now();
  await assertNode.rejects(() => moderate("x", { env: env({ OPENAI_API_KEY: "k" }), request: hang as typeof fetch, timeoutMs: 50 }));
  assert(Date.now() - t0 < 1000, "cut at the deadline");
});

Deno.test("moderation is ON by default from the committed release constant; =off is the emergency disable; no key logs loudly once", async () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  eq(PRODUCTION_CRISIS_MODERATION, "on", "the release ships it on");
  let doorCalls = 0;
  const door = () => { doorCalls++; return Promise.resolve({ results: [{ categories: { "self-harm": true } }] }); };
  const client = moderationFromEnv(env({}), door);
  assert(client, "on with no environment setting at all");
  eq((await crisisScreen(OBLIQUE, client)).distress, true);
  eq(doorCalls, 1, "the gateway door was used");
  for (const v of ["off", "OFF", " off "]) eq(moderationFromEnv(env({ CAREER_CRISIS_MODERATION: v }), door), null, `the emergency disable: ${v}`);
  for (const v of ["on", "yes", "typo"]) assert(moderationFromEnv(env({ CAREER_CRISIS_MODERATION: v }), door), `only "off" disables: ${v}`);
  eq(moderationFromEnv(env({}), door, { release: "off" }), null, "a release that ships it off is off");
  eq(moderationReleaseOn(env({})), true); eq(moderationReleaseOn(env({ CAREER_CRISIS_MODERATION: "off" })), false);
  // no key: off, and one loud line per cold start (never the text)
  const q = quiet();
  eq(moderationFromEnv(env({}), undefined, { log: q.log }), null);
  eq(moderationFromEnv(env({}), undefined, { log: q.log }), null);
  eq(q.lines.length, 1, "said once");
  assert(/CRISIS SCREEN DEGRADED/.test(q.lines[0]) && /word list alone/.test(q.lines[0]), q.lines[0]);
  assert(typeof moderationFromEnv(env({ OPENAI_API_KEY: "k" })) === "function", "with a key, the real gateway door");
  const live = Deno.readTextFileSync(new URL("../../scripts/launch/trainee-go-live.sh", import.meta.url));
  assert(!/CAREER_CRISIS_MODERATION/.test(live), "not gated by the deploy script");
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/career_crisis_screen.ts", import.meta.url));
  assert(/^export const PRODUCTION_CRISIS_MODERATION: "on" \| "off" = "on";$/m.test(src), "the committed release line");
  const code = src.replace(/\/\/[^\n]*/g, "");
  assert(!/api\.openai\.com|OPENAI_API_KEY/.test(code), "the screen holds no URL and reads no key");
  eq((code.match(/env\.get\(/g) ?? []).length, 4, "the two release flags, the model key, and the pass-through that hands the gateway its own environment");
});

Deno.test("the handler starts the screen before the turn's reads and decides distress from its verdict", () => {
  const h = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const at = (re: RegExp) => { const m = re.exec(h); assert(m, `${re}`); return m!.index; };
  const start = at(/const crisisPending = crisisScreen\(message, \{ moderation: moderationFromEnv\(Deno\.env\), classifier: classifierFromEnv\(Deno\.env\) \}\);/);
  assert(start < at(/const loaded = await persistence\.load/), "started before the thread's state is read");
  assert(start < at(/const distress = /) && /const crisis = await crisisPending;[\s\S]{0,300}const distress = !tapIn && !careerTask && !careerBatch && crisis\.distress;/.test(h));
  assert(/trustTurn\(\{ message, distress, deps:/.test(h), "the trust turn answers what the screen flagged");
});

// ---- Layer 3: the crisis classifier (a fake model call; nothing leaves the process) ----
const fakeCall = (said: string | Error | "hang") => { const calls: any[] = []; const call = (cfg: any, payload: any, o: any) => { calls.push({ cfg, payload, o }); return said === "hang" ? new Promise(() => {}) : said instanceof Error ? Promise.reject(said) : Promise.resolve({ content: [{ type: "text", text: said }] }); }; return { calls, call }; };
const KEYED = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ OPENAI_API_KEY: "k", ...o } as Record<string, string>)[k] });

Deno.test("classifier: YES flags a message the list and moderation both miss; any yes wins; it is on by default", async () => {
  const f = fakeCall("YES");
  const c = classifierFromEnv(KEYED(), f.call as any)!;
  assert(c, "on by default");
  const v = await crisisScreen(OBLIQUE, { moderation: clear, classifier: c });
  eq(v.distress, true); eq(v.classifier, "flagged"); eq(v.moderation, "clear");
  eq(f.calls.length, 1);
  assert(String(f.calls[0].payload.system).startsWith(CRISIS_SCREEN_MARKER), "the fixed marker leads the prompt");
  eq(f.calls[0].payload.messages[0].content, OBLIQUE);
  eq(f.calls[0].o.role, "router"); eq(f.calls[0].o.timeoutMs, 2500);
  for (const cue of ["note", "giving belongings away", "won't be around", "bridge", "pills", "garage", "tonight"]) assert(CLASSIFIER_PROMPT.includes(cue), `the prompt names ${cue}`);
});

Deno.test("classifier: NO is clear; an error, a timeout or an unreadable answer never suppresses another layer's yes, and is not logged", async () => {
  eq((await crisisScreen(CAREER, { classifier: classifierFromEnv(KEYED(), fakeCall("no").call as any) })).distress, false);
  for (const bad of [new Error("boom"), "maybe" as const]) {
    const q = quiet();
    const v = await crisisScreen(OBLIQUE, { moderation: flag(), classifier: classifierFromEnv(KEYED(), fakeCall(bad).call as any) }, { log: q.log });
    eq(v.distress, true, "moderation's yes stands"); eq(v.moderation, "flagged");
    eq(q.lines.length, 0, "a classifier failure is not logged");
  }
  const q = quiet(), t0 = Date.now();
  const v = await crisisScreen(CAREER, { moderation: clear, classifier: classifierFromEnv(KEYED(), fakeCall("hang").call as any) }, { classifierTimeoutMs: 50, log: q.log });
  eq(v.distress, false); eq(v.classifier, "timeout"); assert(Date.now() - t0 < 1000); eq(q.lines.length, 0);
  // the classifier's yes stands even when moderation errors
  const e = await crisisScreen(OBLIQUE, { moderation: () => Promise.reject(new Error("x")), classifier: classifierFromEnv(KEYED(), fakeCall("Yes.").call as any) }, { log: quiet().log });
  eq(e.distress, true); eq(e.classifier, "flagged"); eq(e.moderation, "error");
});

Deno.test("classifier: the model comes from one key with a price; no price or no key turns it off loudly; =off disables it", () => {
  const f = fakeCall("no");
  eq(classifierFromEnv(KEYED({ CAREER_CRISIS_CLASSIFIER: "off" }), f.call as any), null, "the emergency disable");
  eq(classifierFromEnv(KEYED(), f.call as any, { release: "off" }), null);
  const q = quiet();
  eq(classifierFromEnv(KEYED({ CAREER_CRISIS_MODEL: "no-such-model" }), f.call as any, { log: q.log }), null, "a model with no price is refused");
  assert(/CRISIS CLASSIFIER OFF: model no-such-model has no price/.test(q.lines[0] ?? ""), q.lines.join("|"));
  const q2 = quiet();
  eq(classifierFromEnv({ get: () => undefined }, f.call as any, { log: q2.log }), null, "no key: off");
  assert(/no model key/.test(q2.lines[0] ?? ""), q2.lines.join("|"));
  const c = classifierFromEnv(KEYED({ CAREER_CRISIS_MODEL: "gpt-5-mini" }), f.call as any)!;
  c("x", new AbortController().signal); eq(f.calls.at(-1).cfg.model, "gpt-5-mini", "CAREER_CRISIS_MODEL picks the model");
  const d = classifierFromEnv(KEYED(), f.call as any)!;
  d("x", new AbortController().signal); eq(f.calls.at(-1).cfg.model, "gpt-5-nano", "default: the gateway's current default model");
});
