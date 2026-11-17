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
import assertNode from "node:assert/strict";
import { chatInput, OverCapText } from "../../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { LINK_LIST_MAX_CHARS, LINK_LIST_MAX_LINKS, linkListAsk } from "../../../supabase/functions/_shared/career_apply_link.ts";
import { applyTurn, boundedAll, feedOncePerBoard, LINK_READS_AT_ONCE, LINK_READS_PER_HOST } from "../../../supabase/functions/_shared/career_apply_chat.ts";
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
