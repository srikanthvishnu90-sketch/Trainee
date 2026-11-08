// APPROVAL WIDENING (S2 review of #605 and #611, 2026-11-08): a yes must never approve more than the person meant.
//   1. "it" names ONE item: "send it", "send this one", "send that", "approve the draft", "isko bhejo" approve only when
//      exactly one item is waiting, on a card, an outreach batch and a follow-up batch; with more, nothing is approved.
//   2. A held letter folds only to an ENGLISH word, and a real English word is never folded: "send less" is not "send les"
//      (French "them"), "send loss" not "los" (German "go"), "haaa" not "haa", "send dass" not "das".
//   3. A yes is a clear yes in ONE language: English "y" with a Spanish/French/German word ("y la", "y das", "y les",
//      "todos y", "y los"), Spanish "si" ("if") with more than padding ("si todos"), or words of two other languages
//      together approve nothing.
// Every case runs through the reader and through the real decision code over its in-memory store, each item bound to
// the hash it was shown with. Existing assertions elsewhere are unchanged.
// deno-lint-ignore-file no-explicit-any require-await
import assertNode from "node:assert/strict";
import { approvalWords, readApproval } from "../../supabase/functions/_shared/approval_words.ts";
import { parseCardReply } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { ACTIONS_INTENT, actionHash, memoryRepliesStore, repliesTurn } from "../../supabase/functions/_shared/career_outreach_replies.ts";
import { db as cardDb } from "./mass-submit-fixture.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const T0 = Date.parse("2026-11-08T15:00:00Z");
const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

async function card(n: number, message: string): Promise<number[]> {
  const d = cardDb({ n });
  eq((await d.say("show my applications"))?.status, "shown");
  await d.say(message);
  const c = d.cards[0];
  for (const q of d.queue) eq(q.approval, c.items.find((i) => i.prepared_id === q.prepared_id)!.payload_hash, `${message}: queued under the hash shown`);
  return d.queue.map((q) => c.items.find((i) => i.prepared_id === q.prepared_id)!.n).sort((a, b) => a - b);
}
async function outreach(n: number, message: string): Promise<number[]> {
  const store = memoryOutreachStore();
  const ds: any[] = [];
  for (let i = 1; i <= n; i++) {
    const d: any = { n: i, recipient: { name: `Person ${i} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `p${i}@firm.example`, source: `list.csv, row ${i}` },
      subject: `Question ${i}`, body: `Hi ${i}, a short synthetic note.`, footer: `Sam\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null,
      gmail_id: null, gmail_thread: null, result: null, created_at: new Date(T0).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  await store.saveBatch("U", "TH", ds, T0);
  store.setIntent("TH", OUTREACH_INTENT);
  await outreachTurn({ message, userId: "U", threadId: "TH", now: T0 + 60_000, store, gmailConnected: async () => true, onApproved: async () => {} });
  const approved = (await store.latestBatch("U")).filter((d) => d.status === "approved");
  for (const d of approved) eq(d.approved_hash === d.hash && d.hash === await payloadHash(messageOf(d)), true, `${message}: approved under the hash shown`);
  return approved.map((d) => d.n).sort((a, b) => a - b);
}
async function followups(n: number, message: string): Promise<number[]> {
  const store = memoryRepliesStore();
  const items = [];
  for (let i = 1; i <= n; i++) {
    const payload = { to: `c${i}@beta.example`, subject: `Re: note ${i}`, text: `Following up ${i}.` };
    items.push({ thread_id: `T${i}`, kind: "followup" as const, payload, hash: await actionHash("followup", payload), step: 1 });
  }
  await store.saveActions("U", items, T0);
  store.setIntent("CH", ACTIONS_INTENT);
  await repliesTurn({ message, userId: "U", chatThreadId: "CH", now: T0 + 60_000, store, tz: "America/Chicago" });
  const approved = store.dump().actions.filter((a: any) => a.status === "approved");
  for (const a of approved) eq(a.approved_hash === a.hash && a.hash === await actionHash(a.kind, a.payload), true, `${message}: approved under the hash shown`);
  return approved.map((a: any) => a.n).sort((x: number, y: number) => x - y);
}

// ------------------------------------------------------------------------------------------------ 1. "it" is one item
const IT = ["send it", "yes, send it", "send it pls", "snd it", "send this one", "send that", "send that one", "approve it", "approve the draft",
  "approve the application", "yes submit it", "send the email", "isko bhejo", "haan isko bhej do", "sí, mándala", "envíalo", "envoie-la", "इसे भेजो"];
Deno.test("WIDENING/1a the reader: every 'it' reply reads as one item, never as the whole batch", () => {
  for (const m of IT) eq(readApproval(m)?.scope, "it", m);
});
Deno.test("WIDENING/1b cards: an 'it' reply approves a card of one; on a card of 2 or 5 nothing is approved", async () => {
  for (const m of IT) {
    eq(await card(1, m), [1], `${m}: a card of one`);
    eq(await card(2, m), [], `${m}: a card of 2 approves nothing`);
    eq(await card(5, m), [], `${m}: a card of 5 approves nothing`);
  }
  // The card's own parser marks the reply as one item.
  for (const m of ["send it", "approve it", "submit it", "yes, send it"]) eq(parseCardReply(m), { kind: "yes", except: [], it: true }, m);
});
Deno.test("WIDENING/1c outreach and follow-ups: an 'it' reply approves a batch of one; a batch of 2 or 5 approves nothing", async () => {
  for (const m of IT) {
    eq(await outreach(1, m), [1], `${m}: one draft`);
    eq(await outreach(2, m), [], `${m}: two drafts approve nothing`);
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
    eq(await followups(5, m), [], `${m}: five follow-ups approve nothing`);
  }
});
Deno.test("WIDENING/1d the whole batch is still approved by a batch yes", async () => {
  for (const m of ["yes", "yes pls", "send all", "send them", "approve all", "sí", "haan bhej do", "oui, envoie-les"]) {
    eq(await card(5, m), all(5), `${m}: card of 5`);
    eq(await outreach(5, m), all(5), `${m}: five drafts`);
  }
});

// ------------------------------------------------------------------------------------------------ 2. held letters
const NOT_FOLDED = ["send less", "send loss", "haaa", "send dass", "send lesss", "send loooss", "haaaa", "send pass", "send boss", "yes less", "goo", "send goo"];
Deno.test("WIDENING/2 a held letter folds only to an English word, and a real English word is never folded", async () => {
  for (const m of NOT_FOLDED) {
    eq(readApproval(m), null, m);
    eq(approvalWords(m), m, `${m} is passed on unchanged`);
    eq(await card(5, m), [], `${m}: card of 5 approves nothing`);
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
  }
  // English held letters still fold.
  for (const [m, want] of [["yesss", "yes"], ["pleeease send", "yes"], ["send allll", "send all"], ["okk send", "yes"]]) eq(approvalWords(m), want, m);
});

// ------------------------------------------------------------------------------------------------ 3. one language
const MIXED = ["y la", "y das", "y les", "todos y", "si todos", "y los", "y todos", "y sab", "y tous", "y alle", "y tudo", "la y", "les y", "si mándala", "si envía",
  "oui, manda", "ja, envía", "sim, envoie", "haan, envoie", "oui bhej do", "ja sab", "sí, schick"];
Deno.test("WIDENING/3 a yes in ONE language only: English 'y' plus another language, 'si' plus more, or two other languages approve nothing", async () => {
  for (const m of MIXED) {
    eq(readApproval(m), null, m);
    eq(approvalWords(m), m, `${m} is passed on unchanged`);
    eq(await card(5, m), [], `${m}: card of 5 approves nothing`);
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
  }
  // One language (or English with one, as Hinglish is) still reads.
  for (const [m, want] of [["si", "yes"], ["si, claro", "yes"], ["si por favor", "yes"], ["sí, envíalos", "send all"], ["sim, manda", "yes"], ["sí, manda", "yes"],
    ["yes bhej do", "yes"], ["haan, bhej do", "yes"], ["oui, envoie-les", "send all"], ["ja bitte", "yes"], ["yes please", "yes"], ["y", "yes"], ["y pls", "yes"]]) {
    eq(approvalWords(m), want, m);
  }
});

// ------------------------------------------------------------------------------------------------ 4. second review (#614)
// B1: Object.prototype names are not words of any table ("yes constructor": Constructor is an employer).
const PROTO = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
  "__defineGetter__", "__lookupGetter__"];
Deno.test("WIDENING/4 Object.prototype names are not approval words: 'send constructor', 'yes toString' approve nothing", async () => {
  for (const p of PROTO) {
    for (const m of [`send ${p}`, `yes ${p}`, `${p}`, `yes, send ${p}`, `sí, mándala ${p}`, `haan ${p}`, `approve ${p}`, `${p} yes`]) {
      eq(readApproval(m), null, m);
      eq(readApproval(m, { languages: "en" }), null, `${m} (en)`);
      eq(approvalWords(m), m, `${m} is passed on unchanged`);
      eq(await card(5, m), [], `${m}: card of 5 approves nothing`);
      eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
    }
  }
});
// B2 (architect ruling R9): "schick es ab" ("send IT off") names one item, as "mándalo" does; "mach es" stays "do it".
Deno.test("WIDENING/5 'schick es ab' names one item: a card or batch of one, never of more; 'mach es' is still the batch 'do it'", async () => {
  for (const m of ["ja, schick es ab", "schick es ab bitte", "schick es ab"]) {
    eq(readApproval(m)?.scope, "it", m);
    eq(await card(1, m), [1], `${m}: card of one`);
    eq(await card(5, m), [], `${m}: card of 5 approves nothing`);
    eq(await outreach(1, m), [1], `${m}: one draft`);
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
  }
  for (const m of ["mach es", "mach das", "do it", "hazlo"]) eq(readApproval(m)?.scope, "batch", m);
});
// N1: "send all 3" approves only a batch of exactly 3 waiting.
Deno.test("WIDENING/6 outreach 'send all N' approves only a batch of exactly N waiting", async () => {
  for (const m of ["send all 3", "approve all 3", "send them all 3"]) {
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
    eq(await outreach(3, m), all(3), `${m}: three drafts approve exactly the 3`);
  }
  eq(await outreach(2, "send all 5"), [], "send all 5 with two waiting approves nothing");
});
// N2: Hindi "ya" is "or": "ya" never joins another language.
Deno.test("WIDENING/7 'ya' (Hindi 'or') never joins another language: 'ya les', 'ya sab', 'ya la' approve nothing", async () => {
  for (const m of ["ya les", "ya sab", "ya la", "ya todos", "ya bhej do", "sab ya", "ya alle", "ya tudo", "ya, envíalos"]) {
    eq(readApproval(m), null, m);
    eq(await card(5, m), [], `${m}: card of 5 approves nothing`);
    eq(await outreach(5, m), [], `${m}: five drafts approve nothing`);
  }
  for (const [m, want] of [["ya", "yes"], ["ya send it", "yes, send it"], ["ya send all", "send all"]]) eq(approvalWords(m), want, m);
});
// The reply to an "it" on more than one asks a clear question that names the count.
Deno.test("WIDENING/8 an 'it' reply on 2+ items asks 'Send all N, or which ones?' and approves nothing", async () => {
  for (const n of [2, 5]) {
    const d = cardDb({ n });
    await d.say("show my applications");
    for (const m of ["yes send it", "sí, envíala", "isko bhejo", "send this one", "schick es ab"]) {
      const r = await d.say(m);
      eq(r?.status, "unclear", `${m}: card of ${n}`);
      assertNode.ok(r!.reply.includes(`Send all ${n}, or which ones?`), `${m}: the card names the count: ${r!.reply}`);
      eq(d.queue.length, 0, `${m}: nothing queued`);
    }
  }
  const store = memoryOutreachStore();
  const ds: any[] = [];
  for (let i = 1; i <= 5; i++) {
    const d: any = { n: i, recipient: { name: `P ${i} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `q${i}@firm.example`, source: `r${i}` }, subject: `Q ${i}`,
      body: `Hi ${i}.`, footer: `Sam\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null,
      created_at: new Date(T0).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  await store.saveBatch("U", "TH", ds, T0);
  for (const m of ["yes send it", "sí, envíala", "isko bhejo", "send this one", "send all 3"]) {
    store.setIntent("TH", OUTREACH_INTENT);
    const r = await outreachTurn({ message: m, userId: "U", threadId: "TH", now: T0 + 60_000, store, gmailConnected: async () => true });
    assertNode.ok(r && r.reply.includes("Send all 5, or which ones?"), `${m}: the batch names the count: ${r?.reply}`);
  }
  eq((await store.latestBatch("U")).filter((d) => d.status === "approved").length, 0, "nothing approved");
});
