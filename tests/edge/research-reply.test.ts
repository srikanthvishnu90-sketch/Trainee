// RESEARCH ANSWER LAYOUT (owner, 2026-10-28): the research reply shape, its report, and delivery as separate messages per
// channel. A scripted model and fake fetch at the HTTP boundary only: no model, no web, no platform is called.
// Check: deno test -A --no-check tests/edge/research-reply.test.ts
import assertNode from "node:assert/strict";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { buildResearchReply, composeResearchDraft, deliverResearch, NO_SOURCES, researchParts, researchTurn, UNSUPPORTED, webParts, type ResearchDraft } from "../../supabase/functions/_shared/research_reply.ts";
import { memoryReportStore } from "../../supabase/functions/_shared/research_report_store.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { whatsappAdapter } from "../../supabase/functions/_shared/whatsapp.ts";
import { loopMessageAdapter } from "../../supabase/functions/_shared/loopmessage_adapter.ts";
import { handleReport } from "../../supabase/functions/trainee-report/handler.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
const SECRET = "s".repeat(40), BASE = "https://trainee.example.app/functions/v1/trainee-report";
const Q = "What were the underlying issues with LinkedIn?";
const A = "https://reviews.example.org/linkedin";
const B = "https://forum.example.net/threads/linkedin-problems";
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  [A]: html("LinkedIn reviews", "<p>I got stuck in a login loop for two days.</p><p>My account was restricted with no reason given.</p><p>The job filters ignore my location settings.</p>"),
  [B]: html("LinkedIn problems thread", "<p>The app is full of bugs since the last update.</p><p>Recruiter spam fills my inbox every day.</p>"),
};
function fakeWeb() {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = PAGES[url];
    return body ? new Response(body, { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { f, calls };
}
const goodDraft = (): ResearchDraft => ({
  facts: "Reviews repeatedly mention login loops, restrictions, bugs, weak job filters and spam.",
  interpretation: "that trust, reliability and application feedback are the main problems",
  limits: "These reviews don't prove LinkedIn's internal technical causes.",
  details: [
    { text: "Login loops lock people out", quote: "stuck in a login loop", url: A },
    { text: "Accounts restricted without a stated reason", quote: "restricted with no reason given", url: A },
    { text: "Job filters ignore location", quote: "job filters ignore my location", url: A },
    { text: "Bugs after updates", quote: "full of bugs since the last update", url: B },
    { text: "Recruiter spam", quote: "Recruiter spam fills my inbox", url: B },
  ],
});
const scripted = (draft: unknown) => { const seen: unknown[] = []; const m = async (p: unknown) => { seen.push(p); return { content: [{ type: "text", text: JSON.stringify(draft) }] }; }; return { m, seen }; };

async function build(o: { draft?: ResearchDraft | null; store?: ReturnType<typeof memoryReportStore>; candidates?: string[]; base?: string | null } = {}) {
  const { f } = fakeWeb();
  const got = await fetchSources(o.candidates ?? [A, B], { fetch: f, now: () => 0 });
  const store = o.store ?? memoryReportStore();
  const reply = await buildResearchReply({ question: Q, draft: o.draft === undefined ? goodDraft() : o.draft, verified: got.verified, candidates: o.candidates ?? [A, B],
    report: { store, userId: "u1", threadId: "t1", base: o.base === undefined ? BASE : o.base, secret: SECRET }, now: Date.UTC(2026, 9, 28) });
  return { reply, store };
}

Deno.test("shape: concise answer (facts, then interpretation, then the limit), no link in the bubble, report stored and read back, a real .txt", async () => {
  const { reply, store } = await build();
  assertEquals(reply.answer, "Reviews repeatedly mention login loops, restrictions, bugs, weak job filters and spam. My interpretation is that trust, reliability and application feedback are the main problems. These reviews don't prove LinkedIn's internal technical causes.");
  assert(!/https?:\/\//.test(reply.answer));
  assert(reply.report?.verified && reply.report.url.startsWith(`${BASE}/r1?u=u1&s=`));
  assertEquals(reply.sources.map((s) => s.url), [A, B]);
  assertEquals(reply.attachment?.mime, "text/plain");
  assert(reply.attachment!.filename.endsWith(".txt") && reply.attachment!.bytes.length > 100);
  const file = new TextDecoder().decode(reply.attachment!.bytes);
  assert(file.includes(A) && file.includes(B) && file.includes('"stuck in a login loop"'));
  // The report: only what the sources say, fact / interpretation / evidence limits apart.
  const page = new TextDecoder().decode(store.rows().get("r1")!.doc.bytes);
  for (const h of ["What the sources say", "My interpretation", "What this evidence doesn't show", "Sources"]) assert(page.includes(`<h2>${h}</h2>`), h);
  assert(page.includes("restricted with no reason given") && page.includes(A) && page.includes(B));
});

Deno.test("parts: text, then the file, then the link alone; web gets the same three pieces and nothing else", async () => {
  const { reply } = await build();
  assertEquals(researchParts(reply, { attach: true }).map((p) => p.kind), ["text", "attachment", "link"]);
  const w = webParts(reply, { attach: true });
  assertEquals(w.map((p) => p.type), ["text", "file", "link"]);
  assertEquals((w[2] as { url: string }).url, reply.report!.url);
  assert(!JSON.stringify(w).match(/button|card|action/i));
});

function platform() {
  const calls: { url: string; body: any }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let body: any = init?.body;
    if (body instanceof FormData) body = { form: [...body.keys()], filename: (body.get("document") as File | null)?.name ?? null };
    else if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url, body });
    if (url.includes("telegram")) return Response.json({ ok: true, result: { message_id: calls.length } });
    if (url.includes("graph.facebook")) return Response.json({ messages: [{ id: `wamid.${calls.length}` }] });
    return Response.json({ message_id: `lm${calls.length}` });
  }) as typeof fetch;
  return { f, calls };
}
const sleep = async () => {};

Deno.test("telegram: three separate messages in order: the answer, the file (sendDocument), the report link alone", async () => {
  const { reply } = await build();
  const { f, calls } = platform();
  const r = await deliverResearch({ reply, attach: true, address: "12345", adapter: telegramAdapter({ token: "t", fetch: f, sleep, clock: () => 0 }) });
  assertEquals(calls.map((c) => c.url.split("/").pop()), ["sendMessage", "sendDocument", "sendMessage"]);
  assertEquals(calls[0].body.text, reply.answer);
  assert(calls[1].body.filename.endsWith(".txt"));
  assertEquals(calls[2].body.text, reply.report!.url);
  assertEquals(calls[2].body.link_preview_options, { is_disabled: false });
  assertEquals([r.ok, r.states.map((s) => `${s.kind}:${s.status}`)], [true, ["text:delivered", "attachment:delivered", "link:delivered"]]);
});

Deno.test("whatsapp and iMessage: the answer, then the link alone with its preview; the file is recorded as not sent there, never claimed", async () => {
  const { reply } = await build();
  for (const [name, mk] of [
    ["whatsapp", (f: typeof fetch) => whatsappAdapter({ token: "t", phoneNumberId: "p", fetch: f, sleep, clock: () => 0 })],
    ["imessage", (f: typeof fetch) => loopMessageAdapter({ apiKey: "k", fetch: f, sleep })],
  ] as const) {
    const { f, calls } = platform();
    const r = await deliverResearch({ reply, attach: true, address: name === "imessage" ? "+15551234567" : "15551234567", adapter: mk(f) });
    const texts = calls.map((c) => c.body?.text?.body ?? c.body?.text);
    assertEquals(texts, [reply.answer, reply.report!.url], name);
    if (name === "whatsapp") assertEquals(calls[1].body.text.preview_url, true);
    assertEquals(r.states.map((s) => `${s.kind}:${s.status}`), ["text:delivered", "attachment:skipped", "link:delivered"], name);
    assert(!/attach|file/i.test(reply.answer), "the answer never mentions a file");
  }
});

Deno.test("verified-link rule: a link no fetch returned is dropped from the answer, the report and the file, and the answer says so", async () => {
  const draft = goodDraft();
  draft.facts += " Full analysis at https://made-up.example.com/linkedin-analysis.";
  draft.details!.push({ text: "An invented study", quote: "stuck in a login loop", url: "https://made-up.example.com/study" });
  const { reply, store } = await build({ draft });
  assert(!reply.answer.includes("made-up.example.com/"), reply.answer);
  assert(reply.answer.endsWith("I left out a link I couldn't verify (made-up.example.com)."), reply.answer);
  assertEquals(reply.sources.map((s) => s.url), [A, B]);
  assert(reply.dropped.links.some((u) => u.includes("made-up.example.com")));
  assert(!new TextDecoder().decode(store.rows().get("r1")!.doc.bytes).includes("made-up"));
  assert(!new TextDecoder().decode(reply.attachment!.bytes).includes("made-up"));
});

Deno.test("verified-link rule: a LinkedIn candidate is never fetched or linked, and is said", async () => {
  const { f, calls } = fakeWeb();
  const cand = ["https://www.linkedin.com/company/linkedin", A];
  const got = await fetchSources(cand, { fetch: f });
  assert(!calls.some((c) => c.includes("linkedin.com")));
  const reply = await buildResearchReply({ question: Q, draft: { ...goodDraft(), details: goodDraft().details!.filter((d) => d.url === A) }, verified: got.verified, candidates: cand });
  assert(reply.answer.includes("(linkedin.com)"), reply.answer);
  assert(researchParts(reply).every((p) => p.kind !== "link" || !p.url.includes("linkedin.com")));
});

Deno.test("no-source honesty: nothing could be opened, so the answer says so and nothing else goes", async () => {
  const { reply } = await build({ draft: null, candidates: ["https://gone.example.org/x"] });
  assertEquals(reply.answer, `${NO_SOURCES} I left out a link I couldn't verify (gone.example.org).`);
  assertEquals([reply.report, reply.attachment, reply.sources], [undefined, undefined, []]);
  assertEquals(researchParts(reply).map((p) => p.kind), ["text"]);
  const bare = await buildResearchReply({ question: Q, draft: null, verified: [] });
  assertEquals(bare.answer, NO_SOURCES);
});

Deno.test("no-source honesty: pages that don't contain the quoted points support no answer", async () => {
  const draft = goodDraft();
  draft.details = [{ text: "Made-up point", quote: "LinkedIn's servers crashed in 2025", url: A }];
  const { reply } = await build({ draft });
  assertEquals(reply.answer, UNSUPPORTED);
  assertEquals(researchParts(reply).map((p) => p.kind), ["text"]);
});

Deno.test("a sentence claiming a report or file was sent is never the model's to say", async () => {
  const draft = goodDraft();
  draft.facts = "Here's the full report with everything. " + draft.facts + " I've attached the sources.";
  const { reply } = await build({ draft });
  assert(!/report|attached/i.test(reply.answer.split("My interpretation")[0]), reply.answer);
});

Deno.test("failed report store: the answer says the report wasn't saved, and the link is the source the answer stands on, not a report", async () => {
  for (const store of [memoryReportStore({ failPut: true }), memoryReportStore({ corrupt: true })]) {
    const { reply } = await build({ store });
    assertEquals(reply.report, undefined);
    assert(reply.answer.includes("I couldn't save the full report this time"), reply.answer);
    const parts = researchParts(reply, { attach: true });
    assertEquals(parts.map((p) => p.kind), ["text", "attachment", "link"]);
    assertEquals((parts[2] as { url: string }).url, A); // A carries the most grounded points
  }
  const { reply } = await build({ base: null });
  assertEquals([reply.report, reply.dropped.report], [undefined, "not_configured"]);
});

Deno.test("failed delivery: a file that didn't go is recorded and said; an answer that didn't go stops the rest", async () => {
  const { reply } = await build();
  const { f, calls } = platform();
  const failDoc = (async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith("/sendDocument")
    ? Response.json({ ok: false, description: "Bad Request: file upload failed" }, { status: 400 }) : f(input, init)) as typeof fetch;
  let recorded: unknown = null;
  const r = await deliverResearch({ reply, attach: true, address: "12345", adapter: telegramAdapter({ token: "t", fetch: failDoc, sleep, clock: () => 0 }), record: (s) => { recorded = s; } });
  assertEquals(r.ok, false);
  assertEquals(r.states.map((s) => `${s.kind}:${s.status}`), ["text:delivered", "attachment:failed", "link:delivered", "note:delivered"]);
  assertEquals(calls.map((c) => c.body?.text), [reply.answer, reply.report!.url, "The source list file didn't go through."]);
  assertEquals(recorded, r.states);

  const dead = (async () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 })) as typeof fetch;
  const r2 = await deliverResearch({ reply, attach: true, address: "12345", adapter: telegramAdapter({ token: "t", fetch: dead, sleep, clock: () => 0 }) });
  assertEquals(r2.states.map((s) => `${s.kind}:${s.status}`), ["text:failed", "attachment:skipped", "link:skipped"]);
});

Deno.test("flag: off (default), no model call and no research reply; on, a scripted model drafts and code checks it", async () => {
  const { f } = fakeWeb();
  const { m, seen } = scripted(goodDraft());
  const off = await researchTurn({ env: env({}), question: Q, candidates: [A, B], fetchSources: (u) => fetchSources(u, { fetch: f }), model: m });
  assertEquals([off, seen.length], [null, 0]);
  const on = await researchTurn({ env: env({ CAREER_RESEARCH_REPLY: "on" }), question: Q, candidates: [A, B], fetchSources: (u) => fetchSources(u, { fetch: f }), model: m });
  assertEquals(seen.length, 1);
  assert(on!.answer.startsWith("Reviews repeatedly mention"));
  assertEquals(await composeResearchDraft({ on: true, question: Q, sources: [], model: m }), null); // no sources: no model call
  assertEquals(seen.length, 1);
});

Deno.test("trainee-report serves the stored report at its link, and nothing for a wrong signature or another person", async () => {
  const { reply, store } = await build();
  const deps = { env: env({ TRAINEE_REPORT_SECRET: SECRET }), store: () => store };
  const ok = await handleReport(new Request(reply.report!.url), deps);
  assertEquals(ok.status, 200);
  assert((await ok.text()).includes("<h2>What the sources say</h2>"));
  assert(ok.headers.get("content-security-policy")!.includes("default-src 'none'"));
  const bad = reply.report!.url.replace(/s=[0-9a-f]/, (x) => x.endsWith("0") ? "s=1" : "s=0");
  assertEquals((await handleReport(new Request(bad), deps)).status, 404);
  assertEquals((await handleReport(new Request(reply.report!.url.replace("u=u1", "u=u2")), deps)).status, 404);
});
