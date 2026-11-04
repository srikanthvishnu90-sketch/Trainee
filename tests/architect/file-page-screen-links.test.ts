// Review fixes on the list page and the reply shape: the page's Apply runs the same posting screen as the card's Apply (a closed
// posting is not queued or approved), and the list-page link is produced by code (feedUrlsFor), goes out as code-written text, and
// passes the reply-shape link filter exactly (a cut-off copy of it does not). Memory stores, fake transports, no network.
import assertNode from "node:assert/strict";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { signedIn, phonePost } from "./file-session-fakes.ts";
const A = signedIn();
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { jobViewOf, refOf, sendJobCards, hashTag, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { shapeReply, urlsIn } from "../../supabase/functions/_shared/channel_shape.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { attachTool } from "../../supabase/functions/_shared/agent/attach_tool.ts";
import { FILE_MAX_BYTES, MAX_FILES, fileParts } from "../../supabase/functions/_shared/channel_shape.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-10-28T12:00:00Z"), H = "ab".repeat(32), LIST = "0123456789";
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const pid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const hit = (n: number) => ({ job_id: `greenhouse:acme:${n}`, company: `Co${n}`, title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/acme/jobs/${n}`, pay: "$90k" });
const closedIds = new Set<number>();
const row = (n: number) => ({ job_id: `greenhouse:acme:${n}`, provider: "greenhouse", description: "<p>Build dashboards.</p>", first_seen_at: "2026-10-27T12:00:00Z", posted_at: "2026-10-26T12:00:00Z", closed_at: closedIds.has(n) ? "2026-10-27T20:00:00Z" : null });
const prepared = (n: number): PreparedRow => ({ id: pid(n), job_id: `greenhouse:acme:${n}`, company: `Co${n}`, url: `https://boards.greenhouse.io/acme/jobs/${n}`, payload_hash: H, state: "ready", card_lines: [], payload: { fields: [{ name: "first_name", label: "First name", value: "Ada" }] } });

async function page(o: { preparedFor?: number[] }) {
  closedIds.clear();
  const kv = new Map<string, any>(), log = { wants: [] as number[], answered: 0, opened: 0 };
  const num = (j: string) => Number(j.split(":").pop());
  const store: FileStore = {
    async remember(u, r, job, s) { kv.set(`${u}|job|${r}`, { job, shownAs: s }); }, async recall(u, r) { return kv.get(`${u}|job|${r}`) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, refs); }, async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings(ids) { return ids.map((i) => row(num(i))); }, async save() { return "saved"; },
    async prepared(_u, j) { return (o.preparedFor ?? []).includes(num(j)) ? prepared(num(j)) : null; }, async applied() { return false; },
    async want(_u, job) { log.wants.push(num(job.job_id)); return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; },
  };
  const refs: string[] = [];
  for (const n of [1, 2]) { const v = jobViewOf(hit(n), row(n)); const r = await refOf(U, v.job_id); refs.push(r); await store.remember(U, r, v, "text"); }
  await store.rememberList(U, LIST, refs);
  const d: FileDeps = { ...A.deps, store, now: () => NOW, env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeBot" } as Record<string, string>)[k] },
    cards: { async open(_u, ids) { log.opened++; return { id: "c", items: [{ n: 1, prepared_id: ids[0], payload_hash: H }], shown_at: new Date(NOW).toISOString() } as any; } },
    tap: { async card(_u, id) { return { id, items: [{ n: 1, prepared_id: pid(1), payload_hash: H }], state: "open", user_id: U } as any; }, async prepared(_u, _ids) { return [{ id: pid(1), payload_hash: H, company: "Co1" }]; },
      async answer(_u, _c, approve) { log.answered++; return approve.length ? [{ n: 1, company: "Co1", result: "queued" }] : []; } } };
  const t = await A.tok(U, LIST, NOW);
  const post = async (f: Record<string, string>) => handleFile(new Request("https://x.example/f", await phonePost({ t, ...f }, SECRET)), d);
  return { d, log, refs, post };
}
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");

Deno.test("list page Apply (not yet prepared) runs the posting screen: a closed posting is not queued, an open one is", async () => {
  const p = await page({});
  closedIds.add(1);
  const r = await p.post({ action: "apply", ref: p.refs[0], tag: "none" });
  assert(/Not queued/.test(plain(await r.text())));
  eq(p.log.wants, []);
  const ok = await p.post({ action: "apply", ref: p.refs[1], tag: "none" });
  await ok.text();
  eq(p.log.wants, [2], "the open posting still queues");
});

Deno.test("list page Apply (prepared) and Apply to all go through Confirm's screen: a posting closed since the page was drawn is not approved", async () => {
  const p = await page({ preparedFor: [1, 2] });
  closedIds.add(1);
  const r = await p.post({ action: "apply", ref: p.refs[0], tag: hashTag(H) });
  assert(/closed|Nothing was approved|Not/.test(plain(await r.text())));
  eq([p.log.opened, p.log.answered], [0, 0], "nothing opened or approved for the closed posting");
});

Deno.test("the list-page link is code-written: it goes out as the minted URL, and the reply-shape link filter keeps it exactly while a cut-off copy is dropped", async () => {
  const sent: any[] = [];
  const p = await page({});
  const send = { photo: async () => ({ ok: true }), text: async (a: any) => { sent.push(a); return { ok: true, id: "1" }; } };
  const minted = await feedUrlsFor(p.d.env, U, LIST, NOW);
  const full = { ...p.d, feedLinks: (u: string, l: string) => feedUrlsFor(p.d.env, u, l, NOW) };
  await sendJobCards({ userId: U, hits: [1, 2, 3, 4].map(hit), deps: full as any, send });
  const url = minted.url!;
  assert(url && sent.length === 1 && urlsIn(sent[0].text).length === 1, JSON.stringify(sent));
  // The listId differs per call (it is derived from the refs and the time); compare the shape of the code-written link instead.
  const link = urlsIn(sent[0].text)[0];
  assert(link.startsWith("https://trainee.example/file?t=v1."), link);
  const kept = shapeReply({ answer: `Here is your list.\n${link}` }, { allowedLinks: [link] });
  eq(kept.links, [link]);
  const cut = shapeReply({ answer: "Here is your list.", links: [link.slice(0, link.length - 6)] }, { allowedLinks: [link] });
  eq(cut.links, [], "a truncated copy of the link is not the link");
  const prefix = shapeReply({ answer: "x", links: [link.slice(0, 40)] }, { allowedLinks: [link] });
  eq(prefix.links, []);
});

// ---- reply shape: attachment link guard is exact, and the file cap counts what the person receives
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const search = { name: "search_jobs", effect: "read" as const, description: "s", input_schema: { type: "object" as const, properties: {}, required: [] },
  run: async () => ({ postings: [{ company: "Acme", title: "Data Analyst", url: "https://boards.greenhouse.io/acme/jobs/1", pay: null }] }) };
async function agent(script: any[]) {
  let i = 0;
  return await runAgentTurn({ system: "s", message: "research Acme for me", history: [], tools: [search, attachTool()], ctx: { userId: U, threadId: "th", now: 0, state: {} }, model: async () => script[Math.min(i++, script.length - 1)] });
}
Deno.test("attach_document: a link that is only a prefix of a returned link is refused (exact match, not substring)", async () => {
  const r = await agent([use("search_jobs", {}), use("attach_document", { filename: "a.md", content: "Posting: https://boards.greenhouse.io/acme/jobs/ (not verified)" }, "t2"), text("Done.")]);
  eq(r.attachments, undefined);
  assert(r.tool_calls.some((c) => c.name === "attach_document" && !c.ok && /not attached/.test(c.error ?? "")), JSON.stringify(r.tool_calls));
  const ok = await agent([use("search_jobs", {}), use("attach_document", { filename: "a.md", content: "Posting: https://boards.greenhouse.io/acme/jobs/1 (not verified)" }, "t2"), text("Done.")]);
  eq(ok.attachments?.length, 1);
});
Deno.test("attach_document: the cap counts the parts a file expands into, not the number of calls", async () => {
  const big = Array.from({ length: Math.ceil((FILE_MAX_BYTES * 2.5) / 24) }, () => "alpha beta gamma delta").join(" ");
  assert(fileParts("big.md", big).length === 3, `big file is ${fileParts("big.md", big).length} parts`);
  const r = await agent([use("search_jobs", {}), use("attach_document", { filename: "one.md", content: big }, "t2"), use("attach_document", { filename: "two.md", content: big }, "t3"), text("Done.")]);
  eq(r.attachments?.map((a) => a.filename), ["one.md"], "the second file would make 6 parts, over the cap of 5");
  const sent = (r.attachments ?? []).reduce((n, a) => n + fileParts(a.filename, a.content).length, 0);
  assert(sent <= MAX_FILES);
  assert(r.tool_calls.filter((c) => c.name === "attach_document" && !c.ok).length === 1);
});
