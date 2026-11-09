// R10 spec C.2 (D-049): a turn that made a File answers with ONE File card (CAREER_FILE_CARD). On Telegram the card's words go as one
// message whose only link is its inline URL button; on every other channel the card's words end with the plain link as the last
// line. Fake deps here (no network); the handler flow is r10-chat-card-handler.test.ts.
import assert from "node:assert/strict";
import { runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";
import { fileCardOn, withFileCard } from "../../supabase/functions/_shared/file_card_reply.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";

const NOW = Date.parse("2026-11-09T15:45:00Z"), CTX = { now: NOW, tz: "America/Chicago" };
const URL_ = "https://trainee.example/file?t=v1.abc.def";
const SRC = { kicker: "Roles File", title: "Frontend internships", url: URL_, updatedAt: "2026-11-09T15:40:00Z", counts: ["3 roles found", "1 without listed pay"] };
const SAID = ["I found 2 frontend internships that list $30/hr or more, plus 1 that doesn't list pay.", URL_];

Deno.test("C.2 card: off unless CAREER_FILE_CARD=on", () => {
  assert.equal(fileCardOn({ get: () => undefined }), false); assert.equal(fileCardOn({ get: () => "off" }), false); assert.equal(fileCardOn({ get: () => "on" }), true);
});

Deno.test("C.2 card: Telegram - the sentences, then the card whose link rides only the button; the link is never in the words", () => {
  const r = withFileCard({ channel: "telegram", reply: SAID.join("\n"), parts: SAID, src: SRC }, CTX);
  assert.deepEqual(r.parts, [SAID[0]]);
  assert.ok(r.card); assert.equal(r.card!.url, URL_); assert.equal(r.card!.label, "Open the File");
  assert.equal(r.card!.text, "ROLES FILE\nFrontend internships\nUpdated Today 9:40 AM CT - 3 roles found - 1 without listed pay\nOpens your private File - nothing is submitted from chat.");
  assert.doesNotMatch(r.card!.text, /https?:/); assert.doesNotMatch(r.reply, /https?:/);
});

Deno.test("C.2 card: WhatsApp, iMessage and the app - the card's words with the plain link as the last line, one card", () => {
  for (const channel of ["whatsapp", "imessage", "sms", "web"]) {
    const r = withFileCard({ channel, reply: SAID.join("\n"), parts: SAID, src: SRC }, CTX);
    assert.equal(r.card, null);
    assert.equal(r.parts.length, 2, channel); assert.equal(r.parts[0], SAID[0]);
    assert.ok(r.parts[1].startsWith("ROLES FILE\nFrontend internships\n")); assert.ok(r.parts[1].endsWith(`\n${URL_}`));
    assert.equal((r.reply.match(/https:\/\//g) ?? []).length, 1, "the link once, as the last line");
  }
});

Deno.test("C.2 card: the channel carries meta.file_card from agent-chat, https only", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const [fc, keep] of [[{ text: "ROLES FILE\nx", label: "Open the File", url: URL_ }, true], [{ text: "x", label: "Open", url: "http://evil.example" }, false]] as const) {
      globalThis.fetch = (async () => Response.json({ reply: "ok", thread_id: "t1", meta: { file_card: fc } })) as typeof fetch;
      const out = await chatThroughAgent("https://x.supabase.co", "k", { channel: "telegram" })({ userId: "u", threadId: "t1", message: "m", turnKey: "k1" }) as { fileCard?: unknown };
      assert.deepEqual(out.fileCard ?? null, keep ? fc : null);
    }
  } finally { globalThis.fetch = realFetch; }
});

function deps(chatOut: Record<string, unknown>) {
  const sent: { b: string[]; opts?: unknown }[] = [];
  // deno-lint-ignore no-explicit-any
  const d: any = {
    env: { get: () => undefined }, now: () => NOW, render: (t: string) => [t],
    store: { claimMessage: async () => true, person: async (c: string) => ({ userId: "u1", threadId: "t1", contact: c }), refusedBefore: async () => false, createPerson: async () => { throw new Error("no"); },
      setThread: async () => {}, setOptOut: async () => {}, enqueueReply: async () => true },
    reply: async (_c: string, b: string[], opts?: unknown) => { sent.push({ b, opts }); return { ok: true }; },
    chat: async () => ({ status: 200, reply: SAID[0], threadId: "t1", ...chatOut }), deliver: async () => {},
  };
  return { d, sent };
}
const text = (channel: string, t: string) => ({ provider: channel, channel, messageId: String(Math.random()), contact: channel === "telegram" ? "tg:1" : "wa:1", address: "1", kind: "text", text: t });

Deno.test("C.2 card: Telegram sends the card with ONE inline URL button after the reply; other channels send no extra card", async () => {
  const card = { text: "ROLES FILE\nFrontend internships", label: "Open the File", url: URL_ };
  const tg = deps({ fileCard: card });
  // deno-lint-ignore no-explicit-any
  await runInbound(text("telegram", "find me frontend internships") as any, tg.d);
  assert.deepEqual(tg.sent.at(-1), { b: [card.text], opts: { buttons: [[{ text: "Open the File", url: URL_ }]] } });
  const wa = deps({ fileCard: card });
  // deno-lint-ignore no-explicit-any
  await runInbound(text("whatsapp", "find me frontend internships") as any, wa.d);
  assert.equal(wa.sent.length, 0, "WhatsApp: the card already rides the reply's parts with its plain link");
  const off = deps({});
  // deno-lint-ignore no-explicit-any
  await runInbound(text("telegram", "hello") as any, off.d);
  assert.equal(off.sent.length, 0);
});

Deno.test("C.2 card: the Telegram adapter turns the button into reply_markup with the url", async () => {
  // deno-lint-ignore no-explicit-any
  const calls: any[] = [];
  const a = telegramAdapter({ token: "T", fetch: (async (_u: string, i: RequestInit) => { calls.push(JSON.parse(String(i.body))); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch, sleep: async () => {} });
  await a.send("9", ["ROLES FILE\nFrontend internships"], { buttons: [[{ text: "Open the File", url: URL_ }]] });
  assert.deepEqual(calls[0].reply_markup.inline_keyboard, [[{ text: "Open the File", url: URL_ }]]);
  assert.doesNotMatch(calls[0].text, /https?:/);
});
