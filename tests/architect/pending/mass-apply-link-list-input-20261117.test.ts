// ag/ma-09-link-list-input (2026-11-17; source: ag/mass-apply-10 9647f70f6, eval MA14: pasting 122 posting links was refused
// "message too long", HTTP 400 at the 4,000-character cap). A pasted list of posting links to apply to may pass the cap, and
// the independent review of ag/mass-apply-10 (rv-ma, blocker 3, link-list DoS) is closed:
//   P1b  61,505 characters of junk https "links" plus words passed chatInput and could reach the brain (D-002 spend)
//        -> past the cap ONLY an apply ask made of known ATS posting links (career_apply_link.ts linkListAsk); a text let
//           through is code's alone: every model call of that turn refuses it (OverCapText), later turns see it clipped.
//   P1c  1,000 Greenhouse links became 1,000 asks read with one unbounded Promise.all inside one edge invocation
//        -> at most LINK_READS_AT_ONCE reads in flight, LINK_READS_PER_HOST per ATS host, a board's whole feed read once
//           per message however many of its links were pasted.
// D-092 (owner, 2026-11-16, no per-message cap): these bound one message's size and its concurrency against the boards,
// never how many applications a person may make; every link pasted is still read.
// Architect ruling (2026-11-17) on the two limits left open:
//   (3) a turn's link reads have a wall-time budget; links not read within it are kept and said as still being read (never
//       dropped, never counted as read), and the person's "keep going" reads them, until every link is read;
//   (4) an over-cap link list goes straight to the link turn: the handler's other code routes read OVER_CAP_ROUTE_TEXT, never
//       the 64,000 characters (crisis words beside the links excepted, for safety).
import assertNode from "node:assert/strict";
import { chatInput, OverCapText } from "../../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { LINK_LIST_MAX_CHARS, LINK_LIST_MAX_LINKS, linkListAsk, linksAsk, memoryLinkPending, OVER_CAP_ROUTE_TEXT, overCapRoute } from "../../../supabase/functions/_shared/career_apply_link.ts";
import { crisisReply } from "../../../supabase/functions/agent-chat/crisis.ts";
import { applyManyAsk, applyTurn, boundedAll, continueLinksAsk, feedOncePerBoard, LINK_READ_BUDGET_MS, LINK_READS_AT_ONCE, LINK_READS_PER_HOST } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { HISTORY_USER_MAX, historyWindow } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const CAP = 4000;
const gh = (n: number, board = (i: number) => `co${i}co`) => Array.from({ length: n }, (_, i) => `https://boards.greenhouse.io/${board(i)}/jobs/${8000 + i}`);
const allowed = { overCapOk: linkListAsk };

Deno.test("122 pasted posting links to apply to pass the cap, marked as over the cap; a message under the cap is as before", () => {
  const ask = `apply to all of these:\n${gh(122).join("\n")}`;
  ok(ask.length > CAP);
  const r = chatInput(ask, null, CAP, allowed);
  eq(r.ok, true);
  eq((r as { overCap?: boolean }).overCap, true);
  const short = chatInput("apply to https://boards.greenhouse.io/acme/jobs/101", null, CAP, allowed);
  eq(short.ok && (short as { overCap?: boolean }).overCap, undefined, "under the cap: no mark");
  // The first message's whole 1,000 links (the bound on one message's size, not on applications) pass; one more is refused.
  ok(chatInput(`apply to these:\n${gh(LINK_LIST_MAX_LINKS).join("\n")}`, null, CAP, allowed).ok);
  eq(chatInput(`apply to these:\n${gh(LINK_LIST_MAX_LINKS + 1).join("\n")}`, null, CAP, allowed), { ok: false, error: "message too long" });
});

Deno.test("review P1b: everything else over the cap is refused as before", () => {
  const tooLong = { ok: false, error: "message too long" };
  const junk = Array.from({ length: 800 }, (_, i) => `https://x.example/${"a".repeat(55)}${i}`).join(" ");
  eq(chatInput(`summarize these ${junk}`, null, CAP, allowed), tooLong, "junk https links: not posting links");
  eq(chatInput(`apply to these ${junk}`, null, CAP, allowed), tooLong, "an apply ask of junk links");
  eq(chatInput(`summarize these:\n${gh(122).join("\n")}`, null, CAP, allowed), tooLong, "posting links, but not an apply ask");
  eq(chatInput("x".repeat(CAP + 1), null, CAP, allowed), tooLong);
  eq(chatInput(`${"please apply ".repeat(60)}\n${gh(122).join("\n")}`, null, CAP, allowed), tooLong, "long words around the links");
  eq(chatInput(`apply to these:\n${gh(122).join("\n")}\nhttps://www.linkedin.com/jobs/view/123`, null, CAP, allowed), tooLong, "one LinkedIn link: never");
  eq(chatInput(`apply to these:\n${gh(122).join("\n")}\nhttps://boards.greenhouse.io/x/jobs/1?${"a".repeat(600)}`, null, CAP, allowed), tooLong, "an oversized link");
  eq(linkListAsk(`apply to these:\n${gh(900, (i) => `b${i}${"x".repeat(60)}`).join("\n")}`), false, "past LINK_LIST_MAX_CHARS in all");
  // A photo with an over-cap text is never let through (the photo would go to a model with it).
  const photo = [{ data: "iVBORw0KGgo=", media_type: "image/png" }];
  eq(chatInput(`apply to all of these:\n${gh(122).join("\n")}`, photo, CAP, allowed), tooLong);
  // A caller that allows nothing past the cap (handler.ts, every other caller): refused.
  eq(chatInput(`apply to all of these:\n${gh(122).join("\n")}`, null, CAP), tooLong);
});

Deno.test("an over-cap text is code's alone: the turn's model door refuses it; later turns see it clipped", async () => {
  ok(new OverCapText() instanceof Error);
  const handler = await Deno.readTextFile(new URL("../../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  // The one door every model call of the turn goes through (callModel shadows the gateway's) refuses an over-cap text.
  ok(/const callModel: typeof spend\.call = async \(\.\.\.a\) => \{\s*if \(overCap\) throw new OverCapText\(\);/.test(handler), "callModel refuses an over-cap turn");
  ok(/overCapOk: linkListAsk/.test(handler));
  const plain = await Deno.readTextFile(new URL("../../../supabase/functions/agent-chat/handler.ts", import.meta.url));
  ok(!/overCapOk/.test(plain), "handler.ts lets nothing past the cap");
  const big = `apply to all of these:\n${gh(122).join("\n")}`;
  const { history } = historyWindow([{ role: "assistant", content: "x".repeat(5000) }, { role: "user", content: big }]);
  ok(history[0].content.length < big.length && history[0].content.startsWith(big.slice(0, HISTORY_USER_MAX)), "the person's over-cap text, clipped");
  eq(history[1].content.length, 5000, "an assistant turn is not clipped here");
});

Deno.test("boundedAll: every item, in order; at most LINK_READS_AT_ONCE in flight and LINK_READS_PER_HOST per host; a throw is its failure", async () => {
  let now = 0, top = 0;
  const per = new Map<string, number>(), perTop = new Map<string, number>();
  const items = Array.from({ length: 1000 }, (_, i) => ({ i, host: ["greenhouse", "lever", "ashby"][i % 3] }));
  const out = await boundedAll(items, (x) => x.host, async (x) => {
    now++; top = Math.max(top, now);
    per.set(x.host, (per.get(x.host) ?? 0) + 1); perTop.set(x.host, Math.max(perTop.get(x.host) ?? 0, per.get(x.host)!));
    await new Promise((r) => setTimeout(r, 0));
    now--; per.set(x.host, per.get(x.host)! - 1);
    if (x.i === 7) throw Error("boom");
    return x.i;
  }, () => -1);
  eq(out.length, 1000);
  eq(out[7], -1);
  ok(out.every((v, i) => i === 7 || v === i));
  ok(top <= LINK_READS_AT_ONCE && top > 1, `in flight ${top}`);
  for (const [h, n] of perTop) ok(n <= LINK_READS_PER_HOST, `${h}: ${n}`);
  eq(await boundedAll([], () => "x", async () => 1, () => 0), []);
});

Deno.test("review P1c: a pasted list's posting reads are bounded and a board's feed is read once per message; every link is still read", async () => {
  const NOW = Date.parse("2026-11-17T16:00:00Z");
  const boards = ["acme", "brite", "kite"];
  // 45 links over three boards, none on file, the per-posting API absent: before, 45 whole-board reads, all at once.
  const links = Array.from({ length: 45 }, (_, i) => ({ board: boards[i % 3], id: 500 + i }));
  const feed = (board: string) => links.filter((l) => l.board === board).map((l) => ({ job_id: `greenhouse:${l.board}:${l.id}`, ats_id: String(l.id), company: l.board, title: `Data Analyst ${l.id}`,
    location: "Remote", url: `https://boards.greenhouse.io/${l.board}/jobs/${l.id}`, description: "TEST posting." }));
  let reads = 0, inFlight = 0, top = 0;
  const fetchFeed = async (b: { board: string }) => {
    reads++; inFlight++; top = Math.max(top, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return feed(b.board);
  };
  const wants = memoryWantStore();
  const r = await applyTurn({ message: `apply to these:\n${links.map((l) => `https://boards.greenhouse.io/${l.board}/jobs/${l.id}`).join("\n")}`, userId: "u1", now: NOW,
    postings: { search: async () => [] }, wants, apps: async () => [], facts: [], link: { db: memoryPostingsDb(), fetchFeed: fetchFeed as never } } as never);
  eq(r?.status, "queued", r?.reply);
  eq((await wants.list("u1")).length, 45, "every link read and queued");
  eq(reads, 3, "one whole-board read per board");
  ok(top <= LINK_READS_PER_HOST, `board reads in flight ${top}`);
  // The memo keeps the per-posting API and shares one failed read across a board's links.
  let fails = 0;
  const once = feedOncePerBoard(Object.assign(async () => { fails++; throw Error("down"); }, { one: async () => null }) as never);
  ok(typeof (once as { one?: unknown }).one === "function");
  const b = { company: "Acme", provider: "greenhouse", board: "Acme" };
  await Promise.allSettled([once(b), once({ ...b, board: "acme" })]);
  eq(fails, 1);
});


Deno.test("ruling (3): 1,000 slow links: the turn ends within its budget, the rest are kept and said as still being read; 'keep going' reads them all", async () => {
  const NOW = Date.parse("2026-11-17T16:00:00Z"), BUDGET = 300;
  ok(LINK_READ_BUDGET_MS > 0 && LINK_READ_BUDGET_MS <= 60_000, "a budget well inside one edge invocation");
  // 1,000 links on 250 boards (4 each), none on file, each board's read slow.
  const links = Array.from({ length: 1000 }, (_, i) => ({ board: `b${Math.floor(i / 4)}`, id: 9000 + i }));
  const feed = (board: string) => links.filter((l) => l.board === board).map((l) => ({ job_id: `greenhouse:${l.board}:${l.id}`, ats_id: String(l.id), company: `Co ${l.board}`, title: `Data Analyst ${l.id}`,
    location: "Remote", url: `https://boards.greenhouse.io/${l.board}/jobs/${l.id}`, description: "TEST posting." }));
  let reads = 0;
  const fetchFeed = async (b: { board: string }) => { reads++; await new Promise((r) => setTimeout(r, 40)); return feed(b.board); };
  const wants = memoryWantStore(), pending = memoryLinkPending(), db = memoryPostingsDb();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: NOW, postings: { search: async () => [] }, wants, apps: async () => [], facts: [],
    link: { db, fetchFeed: fetchFeed as never, budgetMs: BUDGET, pending } } as never);
  const t0 = performance.now();
  const r = await turn(`apply to these:\n${links.map((l) => `https://boards.greenhouse.io/${l.board}/jobs/${l.id}`).join("\n")}`);
  const took = performance.now() - t0;
  const first = (await wants.list("u1")).length, kept = (pending.rows.get("u1") ?? []).length;
  ok(took < BUDGET + 1500, `the turn took ${Math.round(took)} ms (budget ${BUDGET})`);
  ok(first > 0 && first < 1000, `${first} queued on the first turn`);
  eq(first + kept, 1000, "every link is either read (and queued) or kept; none dropped");
  ok(new RegExp(`the other ${kept} are still being read`).test(r!.reply), r!.reply);
  ok(r!.coverage!.total <= 1000 - kept, `the kept links are not counted as read: ${JSON.stringify(r!.coverage)}`);
  ok(continueLinksAsk("keep going") && continueLinksAsk("ok, keep going please") && !continueLinksAsk("keep going with my resume"));
  let turns = 1;
  while ((pending.rows.get("u1") ?? []).length && turns < 60) {
    const before = (pending.rows.get("u1") ?? []).length;
    const k = await turn("keep going");
    turns++;
    ok((pending.rows.get("u1") ?? []).length < before, `turn ${turns} read some: ${k!.reply.slice(0, 160)}`);
  }
  eq(pending.rows.has("u1"), false, "nothing left to read");
  eq(new Set((await wants.list("u1")).map((w) => w.posting_key)).size, 1000, `all 1,000 read and queued in ${turns} turns`);
  // No place to keep them: each link not read in time is named as not read (paste it again), never dropped silently.
  const w2 = memoryWantStore();
  const r2 = await applyTurn({ message: `apply to these:\n${links.slice(0, 200).map((l) => `https://boards.greenhouse.io/${l.board}/jobs/${l.id + 1}`).join("\n")}`, userId: "u2", now: NOW,
    postings: { search: async () => [] }, wants: w2, apps: async () => [], facts: [], link: { db: memoryPostingsDb(), fetchFeed: fetchFeed as never, budgetMs: 50 } } as never);
  ok(/not read in time just now, and I couldn.t keep it to read later; paste it again/.test(r2!.reply), r2!.reply.slice(0, 300));
  ok((await w2.list("u2")).length < 200, "the ones not read are not queued");
});

Deno.test("ruling (4): a 64,000-character link list reaches only the link turn; every other route reads OVER_CAP_ROUTE_TEXT", async () => {
  const big = `apply to all of these:\n${Array.from({ length: 1000 }, (_, i) => `https://boards.greenhouse.io/board${String(i).padStart(4, "0")}xxxxxxxxxxx/jobs/${4000000 + i}`).join("\n")}`;
  ok(big.length > 60_000 && big.length <= LINK_LIST_MAX_CHARS, String(big.length));
  const t0 = performance.now();
  const input = chatInput(big, null, CAP, allowed);
  const route = overCapRoute((input as { message: string }).message, { crisis: crisisReply });
  const asks = linksAsk(route.links!);
  const ms = performance.now() - t0;
  console.log(`64k link list: chatInput + linkListAsk + overCapRoute + linksAsk in ${ms.toFixed(1)} ms`);
  ok(ms < 2000, `${ms} ms`);
  eq(route.route, OVER_CAP_ROUTE_TEXT);
  eq(route.links, big);
  eq(asks?.asks.length, 1000);
  // The text every other route reads matches nothing: no letters, no digits, no link.
  ok(!/[\p{L}\p{N}]/u.test(OVER_CAP_ROUTE_TEXT) && !/https?:/.test(OVER_CAP_ROUTE_TEXT));
  eq(applyManyAsk(OVER_CAP_ROUTE_TEXT), null);
  eq(linksAsk(OVER_CAP_ROUTE_TEXT), null);
  eq(crisisReply(OVER_CAP_ROUTE_TEXT) ? "crisis" : null, null);
  // Crisis words beside the links: those words are the message (the crisis reply answers), and no link is read.
  const crisis = overCapRoute(`I don't want to live anymore. apply to these:\n${big}`, { crisis: crisisReply });
  eq(crisis.links, null);
  ok(crisis.route.length <= 500 && /don't want to live/.test(crisis.route));
  // In the handler: the swap is made right after the request hash is computed, before the first code route reads the message, and the
  // link turn alone is given the text.
  const h = await Deno.readTextFile(new URL("../../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const swap = h.indexOf("if (overCapTurn) message = overCapTurn.route;");
  ok(swap > h.indexOf("const requestHash = await careerRequestHash(hashedMessage,") && swap > 0, "after the request hash (request-hash-after-redaction-20261107)");
  for (const first of ["connectorAsk(message)", "siteRefusedTurn({ message", "cardTurn({ message", "applyTurn({"]) ok(h.indexOf(first) > swap, `${first} reads the message after the swap`);
  ok(h.includes("message: overCapLinks ?? reach?.apply ?? tailorApply?.apply ?? message"), "the link turn is given the text itself");
  ok(/\(overCapLinks !== null && !siteNo && !planned\) \|\|/.test(h), "the link turn runs on it whatever the other routes' guards");
});
