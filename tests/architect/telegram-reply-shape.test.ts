// Reply shape (owner, 2026-10-28): answer, then attachments as documents, then links as preview messages. Everything runs over a
// fake Telegram transport (a fake fetch under the real adapter) and scripted fake models: no network, no model spend, no database.
import assertNode from "node:assert/strict";
import { telegramAdapter, parseTelegramUpdate } from "../../supabase/functions/_shared/telegram.ts";
import { runInbound, type CoreDeps } from "../../supabase/functions/_shared/channel_inbound.ts";
import { ANSWER_MAX_CHARS, PART_MAX_CHARS, answerParts, planSends, byteLength, FILE_MAX_BYTES, MAX_FILES, MAX_LINKS, safeFilename, shapeForTurn, shapeReply } from "../../supabase/functions/_shared/channel_shape.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { attachTool } from "../../supabase/functions/_shared/agent/attach_tool.ts";
import { SHAPE_RULES } from "../../supabase/functions/_shared/agent/prompt.ts";
import { writerPayload } from "../../supabase/functions/_shared/career_reply_writer.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-10-28T12:00:00Z");

// The fake Telegram: records every Bot API call in order; a document call records the filename, size and type from its form.
function fakeTelegram(o: { failDocument?: boolean } = {}) {
  const calls: { method: string; body: any }[] = [];
  const fetchFake = (async (u: string, init: RequestInit) => {
    const method = String(u).split("/").pop()!;
    if (init.body instanceof FormData) {
      const f = init.body.get("document") as File;
      calls.push({ method, body: { chat_id: init.body.get("chat_id"), filename: f.name, size: f.size, type: f.type, text: await f.text() } });
      if (o.failDocument) return Response.json({ ok: false, description: "nope" }, { status: 400 });
    } else calls.push({ method, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 100 + calls.length } });
  }) as unknown as typeof fetch;
  return { calls, adapter: telegramAdapter({ token: "T", fetch: fetchFake, sleep: async () => {} }) };
}
const para = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i} says something specific about the role.`).join("\n\n");

// LONG ANSWERS WHOLE (beta C12, 2026-11-06): the tests below asserted the old lossy shape (a head plus ONE follow-up capped at
// MORE_MAX_CHARS, its tail dropped, or the rest on a page). A long answer is now whole-sentence parts, each at most
// PART_MAX_CHARS (the outbox's limit), the short head first, nothing cut (tests/architect/writer-long-answers-20261106.test.ts).
Deno.test("shape: a long answer is NEVER a file (owner 2026-10-29): clean complete-sentence head, the rest whole in parts", () => {
  const long = `The posting lists SQL and dashboards, and the company has not said what the role pays. ${"More detail follows here. ".repeat(60)}`;
  const s = shapeReply({ answer: long });
  assert(s.answer.length <= ANSWER_MAX_CHARS && /[.!?]$/.test(s.answer));
  eq(s.attachments, [], "no document of any name");
  eq(s.parts?.length, 2, "the head, then the rest in one part");
  eq(s.parts![0], s.answer);
  assert(s.parts![1].includes("More detail follows here.") && s.parts![1].length <= PART_MAX_CHARS && /[.!?]$/.test(s.parts![1]));
  eq(s.parts!.join(" "), long.trim(), "nothing dropped");
  assert(shapeReply({ answer: "Short and direct." }).attachments.length === 0 && !shapeReply({ answer: "Short and direct." }).parts, "a short answer stays a message");
});

Deno.test("shape: the live teacher answer ends cleanly, never mid-list, and no full-answer.md exists", () => {
  const live = `You are 34 and teach high school, which is a real head start for UX: you already explain things to people who do not want to be explained to, and you test your own work on a live audience every day. ${"A move into UX usually takes six to twelve months of part-time work, and most hiring managers care more about two solid case studies than about any certificate. ".repeat(2)}Do these five things this quarter: 1) Pick and confirm one UX target, such as product design at an education company. 2) Take one structured course and finish it. 3) Build a first case study from a real problem at your school. 4) Talk to three people who made the same switch. 5) Put the case study and a short story of why you are switching on one page.`;
  const s = shapeReply({ answer: live });
  assert(!/:\s*$|\b\d\)\s*\S{0,40}$/.test(s.answer), `head must not dangle: ${s.answer.slice(-60)}`);
  assert(/[.!?]$/.test(s.answer) && s.answer.length <= ANSWER_MAX_CHARS);
  assert(!s.answer.includes("Do these five things") || s.answer.includes("5)"), "a sentence that opens a list never ends the head");
  eq(s.attachments.length, 0);
  assert(s.parts?.[1].startsWith("Do these five things") && s.parts[1].includes("5) Put the case study"), "the list travels whole in the second message");
  assert(/[.!?]$/.test(s.parts![1]));
  assert(!JSON.stringify(s).includes("full-answer"));
});

// (Was: "one sentence longer than the limit ends at a clause with a full stop": the head cut the sentence and added a stop.
// Now a sentence is never cut below the outbox's limit: one long sentence goes whole, as one message.)
Deno.test("shape: one sentence longer than the head limit goes whole (never cut, no ellipsis, nothing added)", () => {
  const one = "You could move toward UX by doing a long list of things like " + "reading, practising, building, testing, ".repeat(40) + "and finally applying.";
  const s = shapeReply({ answer: one });
  eq(s.answer, one); eq(s.parts, undefined);
  eq(s.attachments.length, 0);
});

// (Was: "with the hosted page configured the rest is a link". The overflow page is gone: the research_brief page needs a
// source link, and the rest of an advice answer goes whole in parts instead.)
Deno.test("shape: the rest of a long answer is parts, never a page link and never a file", () => {
  const long = `Start with one target role. ${"Then do the next concrete thing and check it. ".repeat(40)}`;
  const s = shapeReply({ answer: long });
  eq(s.links, []); eq(s.attachments, []);
  assert(s.answer.length <= ANSWER_MAX_CHARS);
  const sent = planSends(s);
  eq(sent.map((x) => x.kind), ["answer", "answer"], "the head and one part, no document step");
});

Deno.test("shape: file names are readable .md/.txt, sizes capped (split into parts, never cut), count capped", () => {
  eq(safeFilename("Company Research!!.md"), { filename: "company-research.md", mime: "text/markdown" });
  eq(safeFilename("../../etc/evil.exe").filename, "evil.md");
  eq(safeFilename("notes.TXT"), { filename: "notes.txt", mime: "text/plain" });
  const big = para(400);
  const s = shapeReply({ answer: "ok", attachments: [{ filename: "posting-list.md", content: big }] });
  assert(s.attachments.length > 1 && s.attachments.length <= MAX_FILES);
  for (const f of s.attachments) assert(byteLength(f.content) <= FILE_MAX_BYTES && /^posting-list-\d+-of-\d+\.md$/.test(f.filename), f.filename);
  const many = shapeReply({ answer: "ok", attachments: Array.from({ length: 9 }, (_, i) => ({ filename: "a.md", content: `x${i}` })) });
  eq(many.attachments.length, MAX_FILES);
  eq(new Set(many.attachments.map((f) => f.filename)).size, MAX_FILES, "names are unique");
  eq(shapeReply({ answer: "ok", attachments: [{ filename: "e.md", content: "  " }] }).attachments.length, 0);
});

Deno.test("shape: links are web addresses a tool returned, one each, capped; they leave the answer text", () => {
  const a = "https://boards.greenhouse.io/acme/jobs/1", b = "https://acme.com/about";
  const s = shapeReply({ answer: `Acme lists the role but not the pay.\n${a}\nMore at ${b}.\nftp://x.y/z javascript:alert(1)`, links: ["not a url", a] }, { allowedLinks: [a, b] });
  eq(s.links, [a, b]);
  assert(!/https?:\/\//.test(s.answer), "no URL left in the answer");
  assert(s.answer.startsWith("Acme lists the role but not the pay."));
  const invented = shapeReply({ answer: `Here.\nhttps://made-up.example/x` }, { allowedLinks: [a] });
  eq(invented.links, []);
  assert(invented.notes.some((n) => /no tool returned/.test(n)));
  const six = shapeReply({ answer: "ok", links: Array.from({ length: 8 }, (_, i) => `https://e${i}.com/p`) });
  eq(six.links.length, MAX_LINKS);
});

Deno.test("turn: shaped only on Telegram, flag on, and a turn that is not an exact payload; otherwise untouched", () => {
  const long = "Sentence one is the answer. " + "Padding sentence here. ".repeat(60);
  const base = { reply: long, writable: true, channel: "telegram", on: true };
  // the reply stays the whole answer (it is what is stored); the parts are what is sent, the short head first
  const sh = shapeForTurn(base);
  assert(sh.parts !== null && sh.parts[0].length <= ANSWER_MAX_CHARS && sh.reply === long.trim() && sh.shape === null);
  for (const off of [{ on: false }, { channel: "web" }, { channel: "whatsapp" }, { writable: false }]) {
    const r = shapeForTurn({ ...base, ...off });
    eq([r.reply, r.shape], [long, null], JSON.stringify(off));
  }
});

Deno.test("transport: the answer, then each document, then each link, one message each, in that order, with preview on and file caps", async () => {
  const t = fakeTelegram();
  const a = "https://boards.greenhouse.io/acme/jobs/1", b = "https://acme.com/about";
  const stored: string[] = [];
  const store: any = { async claimMessage() { return true; }, async person() { return { userId: U, threadId: "th", contact: "tg:42" }; }, async sawInbound() {}, async setOptOut() {}, async setThread() {},
    async enqueueReply(_u: string, _k: string, text: string) { stored.push(text); return true; } };
  const s = shapeReply({ answer: "x", attachments: [{ filename: "company-research.md", content: para(30) }, { filename: "drafts.txt", content: "Draft one." }], links: [a, b] });
  const d: CoreDeps = { env: { get: () => undefined }, now: () => NOW, store, render: (x) => [x],
    // the head-start delivery sends the stored answer through the real adapter, as the outbox would
    deliver: async () => { for (const text of stored) await t.adapter.send("42", [text]); },
    reply: async (_c, bubbles) => t.adapter.send("42", bubbles),
    chat: async () => { return { status: 200, reply: "Acme posts the role; it has not said what it pays.", threadId: "th", shape: { attachments: s.attachments, links: s.links } }; },
    sendFile: async (x) => await t.adapter.sendDocument!(x.contact.slice(3), x), sendLink: async (x) => await t.adapter.sendLink!(x.contact.slice(3), x.url) };
  const r = await runInbound(parseTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "tell me about Acme" } }).message!, d);
  eq(r.body.shaped, { files: 2, links: 2 });
  eq(t.calls.map((c) => c.method), ["sendMessage", "sendDocument", "sendDocument", "sendMessage", "sendMessage"]);
  eq(t.calls[0].body.text, "Acme posts the role; it has not said what it pays.");
  const docs = t.calls.filter((c) => c.method === "sendDocument").map((c) => c.body);
  eq(docs.map((x) => x.filename), ["company-research.md", "drafts.txt"]);
  eq(docs.map((x) => x.type.startsWith("text/")), [true, true]);
  for (const x of docs) assert(x.size <= FILE_MAX_BYTES && x.size > 0);
  for (const [i, u] of [a, b].entries()) {
    const c = t.calls[3 + i].body;
    eq(c.text, u, "a link is alone in its message");
    eq(c.link_preview_options, { is_disabled: false, url: u, prefer_large_media: true });
  }
  eq(t.calls[0].body.link_preview_options.is_disabled, false);
});

Deno.test("transport: with no shape the reply goes as before; a document that fails to send is said, and the links still follow", async () => {
  const none = fakeTelegram();
  const sent: string[] = [];
  const store: any = { async claimMessage() { return true; }, async person() { return { userId: U, threadId: "th", contact: "tg:42" }; }, async sawInbound() {}, async setOptOut() {}, async setThread() {}, async enqueueReply() { return true; } };
  const base = { env: { get: () => undefined }, now: () => NOW, store, render: (x: string) => [x], deliver: async () => {}, reply: async (_c: string, bubbles: string[]) => { sent.push(...bubbles); return { ok: true } as any; },
    sendFile: async (x: any) => await none.adapter.sendDocument!("42", x), sendLink: async (x: any) => await none.adapter.sendLink!("42", x.url) };
  const msg = parseTelegramUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hi" } }).message!;
  await runInbound(msg, { ...base, chat: async () => ({ status: 200, reply: "Plain.", threadId: "th" }) } as CoreDeps);
  eq(none.calls.length, 0);
  const bad = fakeTelegram({ failDocument: true });
  const r = await runInbound(parseTelegramUpdate({ update_id: 3, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hi" } }).message!, { ...base,
    sendFile: async (x: any) => await bad.adapter.sendDocument!("42", x), sendLink: async (x: any) => await bad.adapter.sendLink!("42", x.url),
    chat: async () => ({ status: 200, reply: "See file.", threadId: "th", shape: { attachments: [{ filename: "a.md", content: "x", mime: "text/markdown", bytes: 1 }], links: ["https://acme.com/about"] } }) } as CoreDeps);
  eq(r.body.shaped, { files: 0, links: 1 });
  eq(bad.calls.map((c) => c.method), ["sendDocument", "sendMessage"]);
  assert(sent.some((t) => /couldn't attach the file/.test(t)), "a file that did not go is said, never claimed sent");
});

// ---- the agent side: scripted model, no spend
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const search = { name: "search_jobs", effect: "read" as const, description: "s", input_schema: { type: "object" as const, properties: {}, required: [] },
  run: async () => ({ postings: [{ company: "Acme", title: "Data Analyst", url: "https://boards.greenhouse.io/acme/jobs/1", pay: null }] }) };
async function agent(script: any[], tools = [search, attachTool()]) {
  let i = 0;
  return await runAgentTurn({ system: "s", message: "research Acme for me", history: [], tools, ctx: { userId: U, threadId: "th", now: 0, state: {} }, model: async () => script[Math.min(i++, script.length - 1)] });
}

Deno.test("agent: attach_document stages a file from sourced facts; the turn returns {answer, attachments, linksSeen}", async () => {
  const r = await agent([use("search_jobs", {}), use("attach_document", { filename: "Acme Research.md", content: "# Acme\nData Analyst at Acme: pay not listed (not verified).\nhttps://boards.greenhouse.io/acme/jobs/1" }, "t2"),
    text("Acme has a Data Analyst posting; it does not list pay, so that is unknown.\nhttps://boards.greenhouse.io/acme/jobs/1")]);
  eq(r.stopped, "final");
  eq(r.attachments?.map((a) => a.filename), ["Acme Research.md"]);
  assert(r.linksSeen?.includes("https://boards.greenhouse.io/acme/jobs/1"));
  const sh = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: r.reply, attachments: r.attachments, allowedLinks: r.linksSeen });
  eq([sh.shape?.attachments[0].filename, sh.shape?.links], ["acme-research.md", ["https://boards.greenhouse.io/acme/jobs/1"]]);
  assert(!sh.reply.includes("http"));
});

Deno.test("agent: a file that states an unsourced link or pay figure is refused, never attached; the model is told why", async () => {
  const r = await agent([use("search_jobs", {}), use("attach_document", { filename: "acme.md", content: "Acme pays $185,000 and is described at https://invented.example/acme" }, "t2"),
    text("Acme has a Data Analyst posting that does not list pay.")]);
  eq(r.attachments, undefined);
  assert(r.tool_calls.some((c) => c.name === "attach_document" && !c.ok && /not attached/.test(c.error ?? "")));
});

Deno.test("flag contract: the shape rules and the attach tool exist only when asked for; the writer's Telegram format carries the shape rule", () => {
  assert(/ONE short, plain paragraph/.test(SHAPE_RULES) && /attach_document/.test(SHAPE_RULES) && /could not verify/.test(SHAPE_RULES));
  eq(attachTool().effect, "read");
  const facts = { said: "x", intent: null, status: null, effects: { sent: 0, queued: 0, sendUnknown: 0, wrote: false }, tasks: [], next: [] };
  assert(/Shape: one short paragraph/.test((writerPayload(facts, "hi", "telegram") as any).system));
  assert(!/Shape: one short paragraph/.test((writerPayload(facts, "hi", "web") as any).system));
});

Deno.test("runtime: chatThroughAgent tells agent-chat the channel only when the webhook built it with one, and clamps the shape it gets back", async () => {
  const { chatThroughAgent } = await import("../../supabase/functions/_shared/channel_runtime.ts");
  const bodies: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body)));
    return Response.json({ reply: "x", thread_id: "t", shape: { attachments: [{ filename: "../Big Notes.exe", content: "a" }], links: ["https://acme.com/a", "javascript:x"] } }); }) as typeof fetch;
  try {
    const a = { userId: U, threadId: null, message: "hi", turnKey: "k" };
    const tg = await chatThroughAgent("http://x", "k", { channel: "telegram" })(a);
    await chatThroughAgent("http://x", "k")(a);
    eq([bodies[0].channel, "channel" in bodies[1]], ["telegram", false]);
    eq([(tg as any).shape.attachments[0].filename, (tg as any).shape.links], ["big-notes.md", ["https://acme.com/a"]]);
  } finally { globalThis.fetch = real; }
});

Deno.test("transport: a long answer reaches Telegram as two text messages and no sendDocument", async () => {
  const t = fakeTelegram();
  const long = `Start with one target role. ${"Then do the next concrete thing and check it. ".repeat(40)}`;
  const sh = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: long });
  const store: any = { async claimMessage() { return true; }, async person() { return { userId: U, threadId: "th", contact: "tg:42" }; }, async sawInbound() {}, async setOptOut() {}, async setThread() {}, async enqueueReply() { return true; } };
  const d: CoreDeps = { env: { get: () => undefined }, now: () => NOW, store, render: (x) => [x], deliver: async () => {},
    reply: async (_c, bubbles) => t.adapter.send("42", bubbles),
    chat: async () => ({ status: 200, reply: sh.reply, threadId: "th", ...(sh.parts ? { parts: sh.parts } : {}), ...(sh.shape ? { shape: sh.shape } : {}) }),
    sendFile: async (x) => await t.adapter.sendDocument!(x.contact.slice(3), x), sendLink: async (x) => await t.adapter.sendLink!(x.contact.slice(3), x.url) };
  await runInbound(parseTelegramUpdate({ update_id: 9, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "what now" } }).message!, d);
  assert(!t.calls.some((c) => c.method === "sendDocument"), "nothing to download");
  assert(t.calls.filter((c) => c.method === "sendMessage").length <= 2);
});

Deno.test("attach_document: off for advice and research turns, on only when the person asks for a file", async () => {
  const { attachAsked } = await import("../../supabase/functions/_shared/agent/attach_tool.ts");
  for (const m of ["I'm 34, a high school teacher, and want to become a UX designer. What should I do?", "research Acme for me", "what should my next five steps be", "compare these two offers", "give me a plan for this quarter"]) assert(!attachAsked(m), m);
  for (const m of ["send me a file with that", "can you give me a PDF of the plan", "attach it as a .md", "make it downloadable"]) assert(attachAsked(m), m);
  // the brain registers the tool only behind that check (no other path adds it)
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/career_brain.ts", import.meta.url));
  assert(/o\.shape && attachAsked\(o\.message\) \? \[attachTool\(\)\]/.test(src) && (src.match(/attachTool\(\)/g) ?? []).length === 1);
});

// (Was: "long remainder (>1500 chars): the page gets all of it ...; with no page the second message ends on a sentence and the
// loss is noted". Now there is no page and no loss up to 4 parts.)
Deno.test("long remainder (>1500 chars): every sentence arrives, in whole-sentence parts within the outbox's limit", () => {
  const sent = (i: number) => `Step ${i} is to do the next concrete thing and then check what it showed you.`;
  const body = Array.from({ length: 80 }, (_, i) => sent(i)).join(" "); // ~6 KB
  const reply = `Start with one target role. ${body}`;
  const s = shapeReply({ answer: reply });
  assert(s.parts && s.parts.length >= 2 && s.parts.length <= 4);
  assert(s.parts.every((c) => c.length <= PART_MAX_CHARS && /[.!?]$/.test(c)));
  eq(s.parts.join(" "), reply, "nothing lost, nothing cut mid-sentence");
  assert(s.parts.at(-1)!.includes(sent(79)));
  eq(answerParts(reply).left, "");
});
