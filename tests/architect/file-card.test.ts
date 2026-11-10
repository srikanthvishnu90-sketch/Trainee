// SPEC C.2 / D-049: the chat File card, rendered for every File family in every channel shape the bot serves (Telegram plain and
// HTML, WhatsApp, iMessage, web), over many real state mixes, and held to the spec's rules. Prints one number: rules held / checked.
//   deno test -A --no-check tests/architect/file-card.test.ts
import assertNode from "node:assert/strict";
import { BUCKET_ORDER, CARD_CAPTION, type CardBucket, cardHtml, cardMessages, cardSourceOf, FAMILY_CARD, fileCard, fileCardOn, MAX_CHIPS, withFileCards, bucketOfRole }
  from "../../supabase/functions/_shared/file_card.ts";
import { FAMILIES, type FamilyId } from "../../supabase/functions/_shared/file_family.ts";
import type { FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import type { DeliveryAdapter, SendOptions } from "../../supabase/functions/_shared/channel_adapters.ts";
import { specOf } from "../../supabase/functions/_shared/results_spec.ts";

const URL_ = "https://trainee.example/file?t=v1.abc.def";
const APP = "https://trainee.example/file?list=0123456789";
const AT = Date.UTC(2026, 10, 10, 15, 40); // 9:40 AM in Chicago
let held = 0, checked = 0;
const failures: string[] = [];
const rule = (cond: boolean, what: string) => { checked++; if (cond) held++; else if (failures.length < 30) failures.push(what); };

// Deterministic state mixes: empty-ish, single, every bucket, the spec's specimen, and seeded random mixes up to 40 items.
function mixes(): CardBucket[][] {
  const out: CardBucket[][] = [[], ["needs"], ["review"], ["done"], [...BUCKET_ORDER],
    [...Array(14).fill("ready"), "needs", "needs", "closed"] as CardBucket[]];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 40; k++) out.push(Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => BUCKET_ORDER[Math.floor(rnd() * BUCKET_ORDER.length)]));
  return out;
}
const counted = (states: CardBucket[]) => { const m = new Map<CardBucket, number>(); for (const s of states) m.set(s, (m.get(s) ?? 0) + 1); return m; };
const URLS = /https:\/\/\S+/g;
const hasUrl = (s: string) => /https:\/\/\S+/.test(s);

Deno.test("C.2: every family, every channel shape, every state mix holds the card's rules", () => {
  const families = Object.keys(FAMILIES) as FamilyId[];
  rule(families.length === 15 && families.every((f) => FAMILY_CARD[f]), "a card for each of the fifteen families");
  for (const fam of families) for (const states of mixes()) for (const webApp of [null, APP]) {
    const c = fileCard({ family: fam, title: `${FAMILIES[fam].name} title`, batch: fam === "F-05" ? "Batch B-01" : null, updatedAt: AT, items: states.map((state) => ({ state })), url: URL_, webApp })!;
    const tag = `${fam} [${states.join(",")}]`;
    const n = counted(states);
    rule(!!c, `${tag}: a card`);
    // kicker, title, freshness with real, exclusive counts that sum
    rule(c.kicker.startsWith(FAMILY_CARD[fam].kicker) && c.kicker === c.kicker.toUpperCase(), `${tag}: caps kicker`);
    rule(c.title.length > 0, `${tag}: title`);
    rule(/^Updated \d{1,2}:\d{2} (AM|PM)( - |$)/.test(c.freshness) && c.freshness.startsWith("Updated 9:40 AM"), `${tag}: freshness time ${c.freshness}`);
    const lineNums = [...c.freshness.split(" - ").slice(1).join(" - ").matchAll(/(?:^| - )(\d+) /g)].map((m) => Number(m[1]));
    rule(lineNums.reduce((a, b) => a + b, 0) === states.length && c.total === states.length, `${tag}: counts sum to the items (${c.freshness})`);
    rule(c.counts.every((x) => n.get(x.bucket) === x.n) && c.counts.length === n.size, `${tag}: each count is its bucket's real count`);
    rule(new Set(c.counts.map((x) => x.bucket)).size === c.counts.length, `${tag}: buckets exclusive`);
    // chips: at most three, true counts, "needs you" always shown when present
    rule(MAX_CHIPS === 3 && c.chips.length <= 3 && c.chips.length === Math.min(3, n.size), `${tag}: ${c.chips.length} chips`);
    rule(c.chips.every((h) => h.label.startsWith(`${n.get(h.bucket)} `)), `${tag}: chip counts`);
    rule(!n.get("needs") || c.chips.some((h) => h.bucket === "needs"), `${tag}: the needs-you chip shows`);
    // follow-up names the exact decision
    const fu = c.followup;
    rule(n.get("needs") ? /need(s)? an answer from you\. The File shows exactly which\.$/.test(fu) : n.get("review") ? /for your yes/.test(fu) : fu.length > 0, `${tag}: follow-up "${fu}"`);
    rule(c.caption === CARD_CAPTION && CARD_CAPTION === "Opens your private File - nothing is submitted from chat", `${tag}: caption`);

    // Telegram (plain and HTML): the link rides only as the one button, never in the text
    for (const html of [false, true]) {
      const m = cardMessages(c, "telegram", { html });
      const btns = m.flatMap((x) => x.buttons?.flat() ?? []);
      rule(m.length === 2 && btns.length === 1 && btns[0].text === FAMILY_CARD[fam].button && (webApp ? btns[0].webApp === webApp : btns[0].url === URL_), `${tag}: telegram one button`);
      rule(m.every((x) => !hasUrl(x.text)) && m[0].text.includes(CARD_CAPTION), `${tag}: telegram text has no raw link`);
      rule(!html || (m[0].text.includes("<b>") && !/<(?!\/?b>)/.test(m[0].text)), `${tag}: telegram html is escaped`);
    }
    // WhatsApp and iMessage: the link is the plain last line, once
    for (const ch of ["whatsapp", "imessage"] as const) {
      const m = cardMessages(c, ch);
      const lines = m[0].text.split("\n");
      rule(m.length === 2 && lines.at(-1) === URL_ && (m[0].text.match(URLS) ?? []).length === 1 && !hasUrl(m[1].text), `${tag}: ${ch} link last line, once`);
      rule(lines[0] === c.kicker && lines[1] === c.title && lines[2] === c.freshness && lines.includes(CARD_CAPTION) && lines.at(-2) === `${FAMILY_CARD[fam].button}:`, `${tag}: ${ch} card layout`);
    }
    // Web: one card, one button
    const h = cardHtml(c);
    rule((h.match(/<a /g) ?? []).length === 1 && (h.match(/class="chip"/g) ?? []).length === c.chips.length && h.includes(CARD_CAPTION) && h.includes(FAMILY_CARD[fam].button), `${tag}: web card`);
  }
  console.log(`FILE CARD RULES: ${held}/${checked} held`);
  assertNode.deepEqual(failures, []);
});

// A fake adapter that records every send.
function fake(channel: "telegram" | "whatsapp" | "imessage", failAt = -1) {
  const sent: { bubbles: string[]; opts?: SendOptions }[] = [];
  let id = 0;
  const a: DeliveryAdapter = { channel, limits: {}, render: (t) => [t], send(_addr, bubbles, opts) {
    if (sent.length === failAt) return Promise.resolve({ ok: false, error: "boom", retryable: true });
    sent.push({ bubbles, opts }); return Promise.resolve({ ok: true, id: `m${++id}`, ids: bubbles.map(() => `m${++id}`) });
  } };
  return { a, sent };
}
const card = (fam: FamilyId, url: string) => fileCard({ family: fam, title: "Climate operations roles", updatedAt: AT, items: [{ state: "ready" }, { state: "needs" }], url })!;

Deno.test("C.2 delivery: one card per result, never a list of raw links, on every texting channel", async () => {
  const L1 = "https://trainee.example/file?t=v1.one.sig", L2 = "https://trainee.example/file?t=v1.two.sig";
  const resolve = (l: string) => Promise.resolve(l === L1 ? card("F-05", L1) : l === L2 ? card("F-09", L2) : null);
  for (const ch of ["telegram", "whatsapp", "imessage"] as const) {
    const { a, sent } = fake(ch);
    const r = await withFileCards(a, resolve).send("1", ["Here is what I found.", L1, L2, "https://example.com/not-ours"], { buttons: [[{ text: "Approve", data: "ap" }]] });
    const all = sent.flatMap((s) => s.bubbles).join("\n");
    rule(r.ok, `${ch}: sent`);
    rule((all.match(/ROLES FILE/g) ?? []).length === 1 && (all.match(/APPLICATION REVIEW/g) ?? []).length === 1, `${ch}: two results, two cards`);
    rule(ch === "telegram" ? !all.includes(L1) && !all.includes(L2) : (all.match(/trainee\.example/g) ?? []).length === 2, `${ch}: each File link once, never raw on Telegram`);
    rule(all.includes("https://example.com/not-ours") && all.startsWith("Here is what I found."), `${ch}: other messages unchanged`);
    rule(JSON.stringify(sent.at(-1)!.opts?.buttons) === JSON.stringify([[{ text: "Approve", data: "ap" }]]), `${ch}: the caller's buttons ride the last message`);
    rule(all.includes("One role needs an answer from you. The File shows exactly which."), `${ch}: the follow-up names the decision`);
  }
  // Off or unresolved: exactly as before.
  const { a, sent } = fake("telegram");
  await withFileCards(a, () => Promise.resolve(null)).send("1", ["hi", L1]);
  rule(sent.length === 1 && sent[0].bubbles[1] === L1, "an unresolved link goes as before");
  rule(!fileCardOn({ get: () => undefined }) && fileCardOn({ get: () => " ON " }) && !fileCardOn({ get: () => "1" }), "CAREER_FILE_CARD reads on only for on");
  // A failure after the card went: the outbox resumes after the card, never sending it twice.
  const f = fake("whatsapp", 2);
  const r = await withFileCards(f.a, resolve).send("1", ["lead", L1, "tail"]);
  rule(!r.ok && (r as { sent?: number }).sent === 2, "a failed follow-up counts the card as sent");
  console.log(`FILE CARD DELIVERY: ${held}/${checked} held`);
  assertNode.deepEqual(failures, []);
});

Deno.test("C.2 sources: a stored File's counts come from its own record; roles from their one primary state", () => {
  const rec = (kind: FileRecord["kind"], data: unknown, state: Record<string, unknown> = {}): FileRecord => ({ id: "0123456789", userId: "u", kind, data, state, tag: null, created_at: AT, expires_at: AT + 1, revoked_at: null });
  const rv = cardSourceOf(rec("application_review", { company: "Example Carbon Co", role: "Operations Associate", review: { answers: [{}, {}, {}], unresolved: [{}] } }))!;
  assertNode.equal(rv.family, "F-09"); assertNode.equal(rv.title, "Application review: Operations Associate, Example Carbon Co");
  assertNode.deepEqual(rv.items.map((i) => i.state), ["ready", "ready", "ready", "needs"]);
  assertNode.deepEqual(cardSourceOf(rec("introduction", { title: "Intro", person: { name: "A" } }, { choice: "introduced" }))!.items, [{ state: "done" }]);
  assertNode.deepEqual(cardSourceOf(rec("introduction", { title: "Intro", person: { name: "A" } }))!.items, [{ state: "review" }]);
  assertNode.equal(cardSourceOf(rec("plan_review", { title: "Prep", variant: "interview_prep", sections: [{ items: [{}, {}] }] }))!.family, "F-13");
  assertNode.equal(cardSourceOf(rec("research_brief", { title: "x" })), null);
  // Roles: an Apply tap is not an application; only the row's own state counts.
  assertNode.equal(bucketOfRole(specOf({ status: null, byHand: false, blocked: null, tag: null } as never)), "ready");
  assertNode.equal(bucketOfRole(specOf({ status: null, byHand: false, blocked: null, tag: "abc" } as never)), "review");
  assertNode.equal(bucketOfRole(specOf({ status: { word: "confirmed", evidence: null, detail: "" }, byHand: false, blocked: null, tag: null } as never)), "progress");
  assertNode.equal(bucketOfRole(specOf({ status: null, byHand: false, blocked: "Posting closed", tag: null } as never)), "closed");
});

Deno.test("C.2 resolver: only our signed File link becomes a card, drawn from that account's own record; off by default", async () => {
  const { createFileService, memoryFileStore } = await import("../../supabase/functions/_shared/file_service.ts");
  const { feedUrlsFor } = await import("../../supabase/functions/_shared/file_link.ts");
  const { fileCardResolver } = await import("../../supabase/functions/_shared/file_card.ts");
  const { adaptersFromEnv } = await import("../../supabase/functions/_shared/channel_registry.ts");
  const vars: Record<string, string> = { TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_FILE_LINK_SECRET: "s".repeat(32), TELEGRAM_BOT_TOKEN: "123:abc" };
  const env = { get: (k: string) => vars[k] };
  const now = () => AT;
  const store = memoryFileStore(), files = createFileService({ store, env, now });
  await store.put({ id: "0123456789", userId: "u1", kind: "application_review", data: { from_prepared: true, company: "Example Carbon Co", role: "Operations Associate", review: { answers: [{}, {}], unresolved: [{}] } },
    state: {}, tag: null, created_at: AT, expires_at: AT + 3600_000, revoked_at: null });
  const link = (await feedUrlsFor(env, "u1", "0123456789", AT)).url!;
  const resolve = fileCardResolver({ env, now, files });
  const c = await resolve(link);
  assertNode.equal(c?.kicker, "APPLICATION REVIEW");
  assertNode.equal(c?.freshness, "Updated 9:40 AM - 2 ready - 1 need answers");
  assertNode.equal(c?.button.webApp, "https://trainee.example/file?list=0123456789", "Telegram's own sign-in rides the one button (B1)");
  assertNode.equal(await resolve(link.replace(/.$/, (x) => (x === "A" ? "B" : "A"))), null, "a forged link is no card");
  assertNode.equal(await resolve((await feedUrlsFor(env, "u2", "0123456789", AT)).url!), null, "another account's link reads nothing of u1's");
  assertNode.equal(await resolve("https://example.com/file?t=x"), null, "a link that is not ours");
  // The switch: off (unset) the adapters are the plain ones; on, the File card rides every channel's send.
  const plain = adaptersFromEnv(env, { fileCards: resolve }).telegram!, on = adaptersFromEnv({ get: (k) => (k === "CAREER_FILE_CARD" ? "on" : vars[k]) }, { fileCards: resolve }).telegram!;
  const bare = adaptersFromEnv(env).telegram!;
  assertNode.equal(plain.send.toString(), bare.send.toString(), "off: the send is the adapter's own");
  assertNode.notEqual(on.send.toString(), bare.send.toString(), "on: the send goes through the File card");
});

// A Supabase client over in-memory rows: the query shapes the card's reads and the modules they mirror use.
function fakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
  return { from(t: string) {
    const f: [string, (v: unknown) => boolean][] = [];
    const rows = () => (tables[t] ?? []).filter((r) => f.every(([c, ok]) => ok(r[c])));
    const b = {
      select: () => b, order: () => b,
      eq: (c: string, v: unknown) => { f.push([c, (x) => x === v]); return b; },
      in: (c: string, vs: unknown[]) => { f.push([c, (x) => vs.includes(x)]); return b; },
      limit: (n: number) => Promise.resolve({ data: rows().slice(0, n), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    };
    return b;
  } };
}

Deno.test("C.2 delivery stays light: the card's read is the File service's own, row for row", async () => {
  const { fileCardReads } = await import("../../supabase/functions/_shared/file_card_reads.ts");
  const { createFileService, supabaseFileKindStore } = await import("../../supabase/functions/_shared/file_service.ts");
  const rec = (id: string, o: Record<string, unknown>) => ({ user_id: "u1", key: `tf:file:${id}`, value: { id, userId: "u1", kind: "draft", data: { title: "D" }, state: {}, tag: null, created_at: AT, expires_at: AT + 10, revoked_at: null, ...o } });
  const admin = fakeAdmin({ career_watch_kv: [rec("000000000a", {}), rec("000000000b", { revoked_at: AT }), rec("000000000c", { expires_at: AT - 1 }), rec("000000000d", { kind: "application_proof", data: {} }),
    rec("000000000e", { kind: "application_review", data: { from_prepared: true } }), rec("000000000f", { userId: "u2" })] });
  const now = () => AT;
  const light = fileCardReads(admin, now), files = createFileService({ store: supabaseFileKindStore(admin), env: { get: () => undefined }, now });
  for (const [u, id] of [["u1", "000000000a"], ["u1", "000000000b"], ["u1", "000000000c"], ["u1", "000000000d"], ["u1", "000000000e"], ["u1", "000000000f"], ["u2", "000000000a"], ["u1", "nope"], ["", "000000000a"]]) {
    assertNode.deepEqual(await light.files.get(u, id), await files.get(u, id), `files.get(${u}, ${id})`);
  }
  // The card's own family names are file_family.ts's.
  assertNode.deepEqual(Object.fromEntries(Object.entries(FAMILY_CARD).map(([k, v]) => [k, v.name])), Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, v.name])));
  // The delivery function's local import graph: no router bundle, and every file under the 1 MB a git read of one file may return
  // (tests/deploy-provenance.test.cjs reads every file of every bundle).
  const seen = new Set<string>(), root = new URL("../../supabase/functions/trainee-deliver/index.ts", import.meta.url);
  const walk = async (u: URL) => {
    if (seen.has(u.href)) return; seen.add(u.href);
    for (const m of (await Deno.readTextFile(u)).matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s*["'](\.\.?\/[^"']+)["']/g)) await walk(new URL(m[1], u));
  };
  await walk(root);
  const paths = [...seen].map((h) => new URL(h).pathname);
  assertNode.ok(!paths.some((p) => /router_core/.test(p)), "trainee-deliver does not carry the router bundle");
  assertNode.ok(paths.every((p) => Deno.statSync(p).size < 1_000_000), "every file the delivery bundle carries is under 1 MB");
  assertNode.ok(paths.some((p) => p.endsWith("_shared/file_card.ts")) && paths.some((p) => p.endsWith("_shared/file_card_reads.ts")), "the card rides the delivery run");
  assertNode.ok(paths.length < 60, `the delivery bundle stays small (${paths.length} local files)`);
});
