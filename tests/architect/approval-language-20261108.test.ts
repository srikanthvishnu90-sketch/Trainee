// APPROVAL LANGUAGE (2026-11-08): how a texted approval is read (supabase/functions/_shared/approval_words.ts).
// The 1,000-task eval (evals/career/e2e, --set full) showed only a bare "yes" reliably approved: "yes pls", "snd it",
// "send 1 pls", "yse send it", "send em all" approved nothing. This file holds the reader to:
//   1. positive tables: each clear approval reads as the one English form the paths parse, in English and (D-044, owner
//      2026-11-08, replacing the 2026-10-29 English-only rule) in Spanish, Hindi/Hinglish, French, German and Portuguese;
//      with { languages: "en" } only English is read;
//   2. negative tables, every language, both settings: negated, mixed, hedged, deferred, a question, a quote, a fragment;
//   3. a seeded fuzz: approval words with any negation anywhere never read as an approval, and never approve through the
//      card or outreach parsers;
//   4. the binding: a yes still approves exactly what was shown, each item under the hash it was shown with.
// deno-lint-ignore-file no-explicit-any require-await
import assertNode from "node:assert/strict";
import { approvalWords, NEGATIONS, readApproval } from "../../supabase/functions/_shared/approval_words.ts";
import { parseCardReply } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT, outreachTurn, parseBatchYes, parseOutreachReply, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { db as cardDb } from "./mass-submit-fixture.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ALL = { languages: "all" } as const;

// ------------------------------------------------------------------------------------------------ 1. positives
const EN_YES: [string, string][] = [
  ["yes", "yes"], ["Yes!", "yes"], ["yes pls", "yes"], ["yes please", "yes"], ["yep go ahead", "yes"], ["yes go ahead", "yes"], ["do it", "yes"],
  ["ok send", "yes"], ["okay, send", "yes"], ["sure, go ahead", "yes"], ["yes lets go", "yes"], ["yes let's go", "yes"], ["yep go", "yes"], ["ok go", "yes"],
  ["yes do it", "yes"], ["yeah thx", "yes"], ["yup 🙏", "yes"], ["yes 👍", "yes"], ["👍", "yes"], ["👍🏽👍", "yes"], ["approve", "yes"], ["send", "yes"],
  ["lgtm", "yes"], ["confirm", "yes"], ["yes go for it", "yes"], ["yo yes send", "yes"], ["YES SEND", "yes"],
  // typos within one letter of a short word list, and held letters
  ["yse", "yes"], ["yess", "yes"], ["yesss", "yes"], ["yeahh", "yes"], ["yes go ahaed", "yes"], ["yes plz", "yes"], ["yes pleaes", "yes"], ["sned", "yes"],
  ["aprove", "yes"], ["submt", "yes"], ["yeha", "yes"],
  // what to approve
  ["send it", "yes, send it"], ["yes, send it", "yes, send it"], ["send it pls", "yes, send it"], ["snd it", "yes, send it"], ["yse send it", "yes, send it"],
  ["ya send it", "yes, send it"], ["yes send it fr", "yes, send it"], ["yes submit it", "yes, send it"], ["send this one", "yes, send it"], ["approve the draft", "yes, send it"],
  ["send all", "send all"], ["send em all", "send all"], ["sned all", "send all"], ["send all of em", "send all"], ["send them", "send all"],
  ["yes, send them all", "send all"], ["approve all of them", "send all"], ["send everything please", "send all"],
  ["send both", "send both"], ["yes send both of them", "send both"],
  ["send 1", "send 1"], ["send 1 pls", "send 1"], ["ya send 1", "send 1"], ["yes, send 1", "send 1"], ["approve 2", "approve 2"], ["approve #2", "approve #2"],
  ["send number 3 please", "send #3"], ["send #1", "send #1"], ["snd 4", "send 4"],
];
const OTHER_YES: [string, string, string][] = [
  // [language, text, reads as]
  ["es", "sí", "yes"], ["es", "si", "yes"], ["es", "sí, envíala", "yes, send it"], ["es", "sí, mándala", "yes, send it"], ["es", "sí, mándalo", "yes, send it"],
  ["es", "envíalo", "yes, send it"], ["es", "mándalos todos", "send all"], ["es", "sí, envíalos", "send all"], ["es", "claro, dale", "yes"], ["es", "sí por favor", "yes"],
  ["es", "envía los dos", "send both"], ["es", "vale, envía", "yes"],
  ["hi", "haan", "yes"], ["hi", "haan, bhej do", "yes"], ["hi", "haan bhejo", "yes"], ["hi", "bhej do", "yes"], ["hi", "yes bhej do", "yes"], ["hi", "haan ji", "yes"],
  ["hi", "sab bhej do", "send all"], ["hi", "dono bhej do", "send both"], ["hi", "theek hai, bhej do", "yes"], ["hi", "haan isko bhej do", "yes, send it"],
  ["fr", "oui", "yes"], ["fr", "ouais", "yes"], ["fr", "oui, envoie-les", "send all"], ["fr", "envoie-la stp", "yes, send it"], ["fr", "vas-y", "yes"],
  ["fr", "oui, envoie les deux", "send both"], ["fr", "d'accord, envoie", "yes"], ["fr", "oui merci", "yes"],
  ["de", "ja", "yes"], ["de", "ja bitte", "yes"], ["de", "ja, schick es ab", "yes"], ["de", "schick alle", "send all"], ["de", "ja, beide senden", "send both"],
  ["de", "jawohl", "yes"], ["de", "passt, abschicken", "yes"],
  ["pt", "sim", "yes"], ["pt", "sim, manda", "yes"], ["pt", "sim, envia tudo", "send all"], ["pt", "pode mandar", "yes"], ["pt", "bora", "yes"],
  ["pt", "sim, manda os dois", "send both"], ["pt", "sim obrigado", "yes"],
  ["hi", "हाँ", "yes"], ["hi", "हां", "yes"], ["hi", "हाँ, भेज दो", "yes"], ["hi", "हां भेजो", "yes"], ["hi", "सब भेज दो", "send all"], ["hi", "दोनों भेजो", "send both"],
  ["hi", "हाँ जी, कृपया भेजो", "yes"],
];

Deno.test("approval language/1: English approvals read as the one form every path parses", () => {
  for (const [text, want] of EN_YES) {
    eq(approvalWords(text), want, text);
    eq(approvalWords(text, ALL), want, `${text} (all languages)`);
  }
});
Deno.test("approval language/2 (D-044): Spanish, Hindi, French, German, Portuguese read by default; with languages: en they approve nothing", () => {
  for (const [lang, text, want] of OTHER_YES) {
    eq(approvalWords(text), want, `${lang}: ${text} reads as the English yes by default (D-044)`);
    eq(approvalWords(text, ALL), want, `${lang}: ${text}`);
    eq(readApproval(text, { languages: "en" }), null, `${lang}: ${text} is not read with languages: en`);
  }
  const langs = new Set(OTHER_YES.map((x) => x[0]));
  for (const l of ["es", "hi", "fr", "de", "pt"]) assertNode.ok(langs.has(l), `a table for ${l}`);
});

// ------------------------------------------------------------------------------------------------ 2. negatives
const NOT_APPROVAL: string[] = [
  // en: negated, mixed, hedged, deferred, questions
  "no", "nope", "nah", "not yet", "not now", "wait", "hold on", "stop", "cancel", "never", "maybe", "later", "yes but change X", "yes but change 2",
  "yes? what's in it", "yes?", "send it?", "send all?", "yes, but not yet", "yes no", "no yes", "yes and no", "yes wait", "wait yes", "send it later",
  "send 1 later", "maybe send 1", "yes if you think so", "yes unless it's bad", "don't send", "do not send", "dont send it", "yes jk", "yes lol jk",
  "yes except 2", "send all except 3", "send all but 2", "yes tomorrow", "send them tomorrow", "yes after lunch", "yes 👎", "👍?", "yes 🤔", "👎", "❌",
  "send none", "approve none", "yes to none", "nooo", "nahhh", "yes... actually no", "ok", "okay", "sure", "k", "go", "ok fine", "sure why not", "fine",
  "yeah right", "yes I guess", "i think so", "hmm yes", "yes edit 2 first", "fix it then send", "send it, change the subject",
  // fragments, look-alikes, quotes, invisible characters
  "ye", "approv", "se", "y3s", "s3nd 4ll", "y​es", "yeś", "y e s", "y-e-s", "Y.E.S", "'yes'", "'Send all'", "\"yes\"", "> yes", "Mom said yes",
  "ѕend all", "gο ahead", "+1", "✅", "✔️", "👌", "🆗", "🙌", "🙏", "🔥",
  // numbers that are not one position
  "yes 3", "send 1 or 2", "send -1", "send 1-3", "approve all 60", "3",
  // other paths' words
  "Approve and submit", "yes please do", "yes, that's my resume", "yes I want alerts for data jobs",
  // es / hi / fr / de / pt: negated or mixed
  "no, no la mandes", "sí pero cambia el asunto", "todavía no", "espera", "sí, mañana", "luego", "¿sí?", "sí?",
  "nahi", "mat bhejo", "abhi nahi", "ruko", "haan par baad mein", "na", "haan? kya hai", "kal bhej do",
  "non", "pas encore", "attends", "oui mais change le sujet", "oui, demain", "non merci",
  "nein", "noch nicht", "warte", "ja aber später", "nicht senden", "ja, morgen",
  "não", "ainda não", "espera aí", "sim mas muda o assunto", "não manda", "sim, amanhã",
  "नहीं", "मत भेजो", "अभी नहीं", "हाँ लेकिन बाद में", "रुको", "हाँ?", "कल भेजो",
  // another language or script, the split "y es"
  "да", "はい", "是的", "sì, mandali", "ja, stuur maar", "da, trimite", "y es", "y\tes",
];
Deno.test("approval language/3: negated, mixed, hedged and spoofed messages are never an approval, in either setting", () => {
  for (const text of NOT_APPROVAL) {
    eq(readApproval(text), null, text);
    eq(readApproval(text, ALL), null, `${text} (all languages)`);
    eq(approvalWords(text, ALL), text, `${text} is passed on unchanged`);
  }
});
Deno.test("approval language/4: the paths still refuse what they refused (count vs number, a yes that is a change)", () => {
  // One bare number on a card may be a count: unclear (tests/architect/mass-apply-end-to-end-20261104.test.ts).
  for (const t of ["approve 2", "send 3", "send 3 pls"]) eq(parseCardReply(t)?.kind, "unclear", t);
  for (const t of ["yes but change X", "yes, change 2 first", "send them, fix the cover letter"]) eq(parseCardReply(t)?.kind, "unclear", t);
  eq(parseCardReply("approve #2"), { kind: "only", only: [2] });
  eq(parseCardReply("send both"), { kind: "yes", except: [], count: 2 });
  eq(parseOutreachReply("send both"), { kind: "send", all: true, ns: [], except: [], both: true });
});

// ------------------------------------------------------------------------------------------------ 3. fuzz
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const APPROVING = ["yes", "yep", "yeah", "ya", "y", "ok", "sure", "send", "approve", "submit", "go ahead", "do it", "send it", "send all", "send them", "send 1",
  "send both", "pls", "please", "thanks", "👍", "🙏", "yse", "sned", "snd", "sí", "envíala", "mándalos", "todos", "haan", "bhej do", "sab", "oui", "envoie",
  "ja", "schick", "bitte", "sim", "manda", "tudo", "lgtm", "now", "fr", "it"];
// Negations, holds and hedges in every language (the reader's own list and phrases built from it).
const NEGATING = [...NEGATIONS, "don't", "do not", "not yet", "not now", "hold on", "no thanks", "abhi nahi", "pas encore", "noch nicht", "ainda não", "todavía no"];
// The subset the card and outreach parsers must also refuse (no scope word such as "except" / "not 2", which states what
// to leave out and is a path's own, tested elsewhere).
const PARSER_NEG = ["no", "nope", "nah", "never", "wait", "hold", "stop", "cancel", "later", "don't", "maybe", "nahi", "mat", "non", "nein", "nicht", "não",
  "espera", "ruko", "warte", "attends", "👎", "❌", "tomorrow", "unless", "if"];
const SEPS = [" ", " ", ", ", ". ", "! ", " - ", ",", "\n"];
function caseVary(r: () => number, t: string) { const c = r(); return c < 0.2 ? t.toUpperCase() : c < 0.4 ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
function compose(r: () => number, neg: string[]): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const k = 1 + Math.floor(r() * 4), parts: string[] = [];
  for (let i = 0; i < k; i++) parts.push(pick(APPROVING));
  const negs = 1 + Math.floor(r() * 2);
  for (let i = 0; i < negs; i++) parts.splice(Math.floor(r() * (parts.length + 1)), 0, pick(neg));
  let s = "";
  parts.forEach((p, i) => { s += (i ? pick(SEPS) : "") + caseVary(r, p); });
  return s + pick(["", "", ".", "!", "!!", " 🙏"]);
}
Deno.test("approval language/5: fuzz, 20,000 messages: no message with a negation in it ever reads as an approval, in either setting", () => {
  const r = rng(20261108);
  const bad: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    const m = compose(r, NEGATING);
    if (readApproval(m) || readApproval(m, ALL) || approvalWords(m, ALL) !== m) bad.push(m);
  }
  eq(bad.slice(0, 10), [], `${bad.length} negated messages read as an approval`);
});
Deno.test("approval language/6: fuzz, 10,000 messages: with a negation, hold or condition in it, the card and outreach parsers approve nothing", () => {
  const r = rng(1108);
  const bad: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    const m = compose(r, PARSER_NEG);
    const card = parseCardReply(m), batch = parseBatchYes(m), reply = parseOutreachReply(approvalWords(m));
    if (card?.kind === "yes" || card?.kind === "only" || batch?.kind === "send" || reply?.kind === "send") bad.push(`${JSON.stringify(m)} card=${card?.kind} batch=${batch?.kind} reply=${reply?.kind}`);
  }
  eq(bad.slice(0, 10), [], `${bad.length} negated messages approved`);
});

// ------------------------------------------------------------------------------------------------ 4. the binding
const T0 = Date.parse("2026-11-08T15:00:00Z");
async function shownDrafts(n: number) {
  const store = memoryOutreachStore();
  const ds: any[] = [];
  for (let i = 1; i <= n; i++) {
    const d: any = { n: i, recipient: { name: `Person ${i} Synthetic`, firm: "Firm", title: "Analyst", school: "", email: `p${i}@firm.example`, source: `list.csv, row ${i}` },
      subject: `Question ${i}`, body: `Hi ${i}, a short synthetic note.`, footer: `Sam\n\n${OPT_OUT_LINE}`, status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null,
      gmail_thread: null, result: null, created_at: new Date(T0).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  await store.saveBatch("U", "TH", ds, T0);
  store.setIntent("TH", OUTREACH_INTENT);
  return store;
}
async function outreachApproves(n: number, message: string): Promise<number[]> {
  const store = await shownDrafts(n);
  const handed: { n: number; approvalHash: string }[] = [];
  await outreachTurn({ message, userId: "U", threadId: "TH", now: T0 + 60_000, store, gmailConnected: async () => true, onApproved: async (_u, items) => { handed.push(...items); } });
  const approved = (await store.latestBatch("U")).filter((d) => d.status === "approved");
  for (const d of approved) eq(d.approved_hash === d.hash && d.hash === await payloadHash(messageOf(d)), true, `${message}: approved under the hash shown`);
  eq(handed.map((h) => h.n).sort(), approved.map((d) => d.n).sort(), `${message}: what the rail got is what was approved`);
  return approved.map((d) => d.n).sort((a, b) => a - b);
}
Deno.test("approval language/7: outreach: a reworded yes approves exactly the drafts shown, each under its own hash", async () => {
  for (const m of ["yes pls", "yse", "yes go ahaed", "send em all", "sned all", "yes, send them all 🙏"]) eq(await outreachApproves(3, m), [1, 2, 3], m);
  for (const m of ["send 1 pls", "snd 1", "ya send 1"]) eq(await outreachApproves(3, m), [1], m);
  for (const m of ["send it pls", "snd it", "yse send it"]) {
    eq(await outreachApproves(1, m), [1], `${m}, one draft`);
    eq(await outreachApproves(3, m), [], `${m}, three drafts: "it" names none of them`);
  }
  eq(await outreachApproves(2, "send both"), [1, 2]);
  eq(await outreachApproves(3, "send both"), [], "send both with three waiting approves nothing");
  for (const m of ["yes but change 2", "send 1 later", "not yet", "yes?", "send all?"]) eq(await outreachApproves(3, m), [], m);
  // D-044: a clear yes in the five languages approves exactly the batch; "it" ("mándala") names one only when one waits.
  for (const m of ["haan bhej do", "oui", "sí", "ja bitte", "sim, manda", "हाँ, भेज दो"]) eq(await outreachApproves(3, m), [1, 2, 3], `D-044: ${m}`);
  eq(await outreachApproves(1, "sí, mándala"), [1], "D-044: sí, mándala, one draft");
  eq(await outreachApproves(3, "sí, mándala"), [], "D-044: sí, mándala, three drafts: 'it' names none of them");
  // Not the thread's last word: a yes approves nothing.
  const store = await shownDrafts(2);
  store.setIntent("TH", "agent");
  eq(await outreachTurn({ message: "yes pls", userId: "U", threadId: "TH", now: T0 + 60_000, store }), null);
});
Deno.test("approval language/8: cards: a reworded yes approves exactly the card shown; 'send 1' approves a card of one, never a card of more", async () => {
  const run = async (n: number, message: string) => {
    const d = cardDb({ n });
    const shown = await d.say("show my applications");
    eq(shown?.status, "shown");
    await d.say(message);
    const card = d.cards[0];
    for (const q of d.queue) eq(q.approval, card.items.find((i) => i.prepared_id === q.prepared_id)!.payload_hash, `${message}: queued under the hash shown`);
    return d.queue.map((q) => card.items.find((i) => i.prepared_id === q.prepared_id)!.n).sort((a, b) => a - b);
  };
  for (const m of ["yes pls", "yep go ahead", "yse", "yes go ahaed", "ok send", "send em all"]) eq(await run(3, m), [1, 2, 3], m);
  // "it" names one application (S2 review of #605): a card of one, never a card of three
  // (tests/architect/approval-widening-20261108.test.ts).
  for (const m of ["yes submit it", "yes send it fr"]) {
    eq(await run(1, m), [1], `${m}, card of one`);
    eq(await run(3, m), [], `${m}, card of three: "it" is one, so nothing is approved`);
  }
  for (const m of ["send 1", "send 1 pls", "approve 1", "snd 1"]) {
    eq(await run(1, m), [1], `${m}, card of one`);
    eq(await run(3, m), [], `${m}, card of three: a count or a number, unclear`);
  }
  eq(await run(3, "approve #2"), [2]);
  eq(await run(2, "send both"), [1, 2]);
  eq(await run(3, "send both"), [], "a card of three is not both");
  for (const m of ["yes but change X", "not yet", "wait", "yes? what's in it", "no", "✅", "ye", "да", "はい"]) eq(await run(3, m), [], m);
  // D-044: a clear yes in the five languages approves exactly the card.
  for (const m of ["sí", "haan", "oui", "ja", "sim", "हाँ"]) eq(await run(3, m), [1, 2, 3], `D-044: ${m}`);
  // A changed application is refused at the answer, whatever the wording of the yes.
  const d = cardDb({ n: 2 });
  await d.say("show my applications");
  d.change(2);
  await d.say("yes pls");
  eq(d.queuedCompanies().length, 1, "only the unchanged application is queued");
});

// ------------------------------------------------------------------------------------------------ 5. D-044, every language
// Owner ruling D-044 (2026-11-08): each clear yes in the table approves exactly what was shown, on the card and on the
// outreach batch, each item under its own hash; the same language negated or hedged approves nothing.
const D044_NEGATED: [string, string][] = [
  ["es", "no, no la mandes"], ["es", "sí pero espera"], ["es", "todavía no"], ["hi", "nahi"], ["hi", "mat bhejo"], ["hi", "haan par baad mein"], ["hi", "नहीं"],
  ["hi", "मत भेजो"], ["fr", "non"], ["fr", "pas encore"], ["fr", "oui mais attends"], ["de", "nein"], ["de", "noch nicht"], ["de", "ja aber später"],
  ["pt", "não"], ["pt", "ainda não"], ["pt", "sim mas espera"],
];
Deno.test("approval language/9 (D-044): every clear yes in the five languages approves exactly the card and the batch shown; each negated form approves nothing", async () => {
  const card = async (n: number, message: string) => {
    const d = cardDb({ n });
    await d.say("show my applications");
    await d.say(message);
    const c = d.cards[0];
    for (const q of d.queue) eq(q.approval, c.items.find((i) => i.prepared_id === q.prepared_id)!.payload_hash, `${message}: queued under the hash shown`);
    return d.queue.map((q) => c.items.find((i) => i.prepared_id === q.prepared_id)!.n).sort((a, b) => a - b);
  };
  for (const [lang, text, want] of OTHER_YES) {
    // "it" names one item: exact on a card of one and a batch of one; a count of two only on two.
    const n = want === "yes, send it" ? 1 : want === "send both" ? 2 : 3;
    const all = Array.from({ length: n }, (_, i) => i + 1);
    eq(await card(n, text), all, `${lang}: ${JSON.stringify(text)} approves exactly the card of ${n}`);
    eq(await outreachApproves(n, text), all, `${lang}: ${JSON.stringify(text)} approves exactly the ${n} drafts`);
  }
  for (const [lang, text] of D044_NEGATED) {
    eq(await card(3, text), [], `${lang}: ${JSON.stringify(text)} approves nothing on the card`);
    eq(await outreachApproves(3, text), [], `${lang}: ${JSON.stringify(text)} approves nothing on the batch`);
  }
});
