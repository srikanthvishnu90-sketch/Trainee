// V1 TEXTING VOICE (PRODUCT AUDIT 2026-10-28): the reply writer at agent-chat's final-reply boundary and channel-native
// delivery. A scripted fake model only; no real model call. Check: deno test -A --no-check tests/edge/reply-writer.test.ts
import assertNode from "node:assert/strict";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
import { factCheck, factsForTurn, templateReply, writable, writeReply, replyWriterOn } from "../../supabase/functions/_shared/career_reply_writer.ts";
import { nativeRender, splitNatural, textingNativeOn } from "../../supabase/functions/_shared/channel_voice.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
const said = "Here are the 2 roles most worth applying to.\nData Analyst at Acme (https://boards.greenhouse.io/acme/jobs/1) — Chicago, IL.\nTell me one to tailor your resume for, and I will do that next.";
const facts = () => factsForTurn({ reply: said, intent: "career_discovery", resultStatus: "prepared", effects: { sent: 0, queued: 0, sendUnknown: 0, writes: new Set() }, situation: null });
const model = (text: string) => async () => ({ content: [{ type: "text", text }] });

Deno.test("flag: off unless CAREER_REPLY_WRITER=on, and off returns today's reply untouched", async () => {
  assertEquals(replyWriterOn(env({})), false);
  assertEquals(replyWriterOn(env({ CAREER_REPLY_WRITER: "on" })), true);
  const w = await writeReply({ on: false, facts: facts(), message: "find me jobs", model: model("anything") });
  assertEquals([w.text, w.source], [said, "off"]);
});

Deno.test("a written reply that keeps to the facts is used", async () => {
  const text = "2 roles worth applying to — the closest is Data Analyst at Acme, Chicago.\nhttps://boards.greenhouse.io/acme/jobs/1\nWant me to tailor your resume for it?";
  const w = await writeReply({ on: true, facts: facts(), message: "find me jobs", channel: "sms", model: model(text) });
  assertEquals([w.source, w.rejected], ["model", []]);
  assertEquals(w.text, text);
});

Deno.test("a written reply that invents a company, a number or a send falls back to the template from the same facts", async () => {
  for (const bad of [
    "Found 2 roles. Data Analyst at Acme and one at Initech.\nhttps://boards.greenhouse.io/acme/jobs/1\nWant me to tailor?",
    "Found 5 roles, best is Acme.\nhttps://boards.greenhouse.io/acme/jobs/1\nWant me to tailor?",
    "I applied to Acme for you.\nhttps://boards.greenhouse.io/acme/jobs/1\nAnything else?",
  ]) {
    const w = await writeReply({ on: true, facts: facts(), message: "find me jobs", model: model(bad) });
    assertEquals(w.source, "template", bad);
    assert(w.rejected.length > 0, bad);
    assert(factCheck(w.text, facts()).length === 0, `the template states nothing new: ${w.text}`);
  }
});

Deno.test("a model failure falls back to the template; the turn never fails", async () => {
  const w = await writeReply({ on: true, facts: facts(), message: "hi", model: async () => { throw new Error("down"); } });
  assertEquals(w.source, "template");
  assert(w.text.includes("https://boards.greenhouse.io/acme/jobs/1"));
});

Deno.test("the template drops canned and internal sentences and keeps a nothing-was-sent sentence", () => {
  const f = factsForTurn({ reply: "I did not catch what to do with that one. Nothing was sent. The browser worker queued it in this handler. Which company?", intent: "x", resultStatus: null, effects: null, situation: null });
  const t = templateReply(f);
  assert(!/did not catch|browser worker|handler/i.test(t), t);
  assert(/Nothing was sent/.test(t), t);
});

Deno.test("approval payloads are never rewritten", () => {
  assertEquals(writable({ intent: "career_apply_card", reply: "card" }, null, { structured: false }), false);
  assertEquals(writable({ intent: "agent", reply: "Subject: Hello\nBody" }, null, { structured: false }), false);
  assertEquals(writable({ intent: "career_discovery", reply: said }, { card_id: "c1" }, { structured: false }), false);
  assertEquals(writable({ intent: "career_discovery", reply: said }, null, { structured: true }), false);
  assertEquals(writable({ intent: "career_discovery", reply: said }, null, { structured: false }), true);
});

Deno.test("channel-native: links on their own line, never cut, no counters, no markdown on SMS", () => {
  assertEquals(textingNativeOn(env({ CAREER_TEXTING_NATIVE: "on" })), true);
  const long = `**Top pick:** Data Analyst at Acme (https://boards.greenhouse.io/acme/jobs/1). ${"It fits your SQL work. ".repeat(20)}\n\nWant me to tailor it?`;
  const parts = nativeRender("sms", 300)(long);
  assert(parts.length > 1);
  for (const p of parts) {
    assert(p.length <= 300, `${p.length}`);
    assert(!/\*\*|\(\d+\/\d+\)/.test(p), p);
  }
  assert(parts.some((p) => p.split("\n").includes("https://boards.greenhouse.io/acme/jobs/1")), "the link stands on its own line, whole");
  assertEquals(splitNatural("short", 300), ["short"]);
});

Deno.test("telegram native: HTML parse mode, and plain text again when Telegram refuses the markup", async () => {
  const sent: any[] = [];
  let first = true;
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    if (first && body.parse_mode === "HTML") { first = false; return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 }); }
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
  }) as typeof fetch;
  const a = telegramAdapter({ token: "t", fetch: fakeFetch, native: true, sleep: async () => {}, clock: () => 0 });
  const r = await a.send("42", a.render("**Hi** there"));
  assert(r.ok, JSON.stringify(r));
  assertEquals(sent[0].parse_mode, "HTML");
  assertEquals(sent[1].parse_mode, undefined);
  assertEquals(sent[1].text, "Hi there");
});
