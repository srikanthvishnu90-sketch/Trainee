// PEOPLE FINDING (D-033, #217 follow-up, lane L8): the scheduled push for introduction reminders, and the never-sends
// invariant. Before this lane, a reminder existed only as a line shown at the person's next message ("I can't message
// you first yet"): nothing ever queued it for delivery. The push follows the product's own pattern — the scheduled
// career-proactive run plans at the due time from the record as it then stands (career_people_reminders.ts
// runIntroReminders), queues ONE text per reminder to career_outbox (kind "followup", once per key, ever) behind
// CAREER_INTRO_REMINDERS=on, and marks the intro reminded so the in-chat line never repeats a pushed reminder.
// Delivery from the outbox is the channel's job and is not proven here: this file proves up to the outbox row.
//
// The never-sends invariant (D-033): Trainee never sends an introduction itself — approval hands the person a mailto
// link or copy-ready text (hash-bound approval itself is pinned in people-turn-unit.test.ts and, on real Postgres, in
// flow-people-finding.test.ts). What was NOT pinned anywhere: that the whole lifecycle writes nothing to the outbox,
// and that the only outbox row this feature ever writes is the reminder the person asked for — never the note itself.
import { engineAware, everyoneKnown } from "./personal-fixture.ts";
import nodeAssert from "node:assert/strict";
import { type Intro, type PeopleDeps, type PeopleStore, peopleTurn, type PersonRec, type Prefs } from "../../supabase/functions/_shared/career_people.ts";
import { runIntroReminders } from "../../supabase/functions/_shared/career_people_reminders.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";

function assert(v: unknown, m?: string): asserts v { nodeAssert.ok(v, m); }
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname;
const FIXTURE = await Deno.readTextFile(`${ROOT}tests/fixtures/people/Connections.csv`);
const U = "u-1", T = "t-1";
const NOW = Date.parse("2026-10-26T18:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

// An intros-only PeopleStore over memory (every other surface stubbed): the sweep reads dueIntros + updateIntro only,
// the turn tests use the import and intro methods. dueIntros mirrors the SQL filter exactly (armed, unreminded,
// approved or sent, due at or before now), oldest due first.
function memoryStore() {
  let id = 0;
  const intros: (Intro & { user_id: string })[] = [];
  const prefs = new Map<string, Prefs>();
  const rows: (PersonRec & { user_id: string; dedupe_key: string })[] = [];
  const store: PeopleStore & { introsOf: typeof intros } = {
    introsOf: intros,
    async pruneThreadContacts() { return { rows: 0, threads: 0 }; },
    async importRows(u, source, _file, _sha, rs, _read, _skipped, replace) {
      let replaced = 0;
      if (replace) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === u && rows[i].source === source) { rows.splice(i, 1); replaced++; }
      let inserted = 0;
      for (const r of rs as any[]) {
        if (rows.some((x) => x.user_id === u && x.source === source && x.dedupe_key === r.dedupe_key)) continue;
        rows.push({ id: ++id, user_id: u, source, name: r.name ?? null, email: r.email ?? null, company: r.company ?? "", company_key: r.company_key ?? "", position: r.position ?? "", school: r.school ?? "",
          connected_on: r.connected_on ?? null, last_seen_at: r.last_seen_at ?? null, source_ref: r.source_ref, source_url: r.source_url ?? null, retrieved_at: iso(NOW), dedupe_key: r.dedupe_key });
        inserted++;
      }
      const mine = rows.filter((x) => x.user_id === u && x.source === source);
      return { inserted, duplicates: rs.length - inserted, kept: mine.length, with_email: mine.filter((x) => x.email).length, replaced };
    },
    async counts(u) { const c: Record<string, number> = {}; for (const r of rows) if (r.user_id === u) c[r.source] = (c[r.source] ?? 0) + 1; return c; },
    async atCompany(u, key) { return rows.filter((r) => r.user_id === u && key && r.company_key === key); },
    async named(u, n) { const w = n.toLowerCase(); const ex = rows.filter((r) => r.user_id === u && r.name?.toLowerCase() === w); return ex.length || w.includes(" ") ? ex : rows.filter((r) => r.user_id === u && r.name?.toLowerCase().startsWith(`${w} `)); },
    async setSchool() { return 0; },
    async forget() { return 0; },
    async prefs(u) { return prefs.get(u) ?? { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null }; },
    async setPrefs(u, p) { prefs.set(u, { ...(prefs.get(u) ?? { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null }), ...p }); },
    async saveJobs() { return 0; }, async jobs() { return []; }, async forgetJobs() { return 0; },
    async intros(u) { return intros.filter((i) => i.user_id === u).map((i) => ({ ...i })); },
    async intro(u, n) { const i = intros.find((x) => x.user_id === u && x.n === n); return i ? { ...i } : null; },
    async addIntro(u, i) {
      const n = Math.max(0, ...intros.filter((x) => x.user_id === u).map((x) => x.n)) + 1;
      const row = { ...i, id: ++id, n, user_id: u, status: "drafted", status_source: null, approved_hash: null, approved_at: null, sent_at: null, follow_up_days: null, follow_up_at: null, reminded_at: null, created_at: iso(NOW) } as Intro & { user_id: string };
      intros.push(row); return { ...row };
    },
    async updateIntro(u, n, patch, onlyIf) {
      const i = intros.find((x) => x.user_id === u && x.n === n);
      if (!i || (onlyIf?.status && !onlyIf.status.includes(i.status)) || (onlyIf?.payload_hash && i.payload_hash !== onlyIf.payload_hash)) return null;
      if (patch.status === "approved" && patch.approved_hash !== (patch.payload_hash ?? i.payload_hash)) throw new Error("check constraint: approved_hash = payload_hash");
      Object.assign(i, patch); return { ...i };
    },
    async forgetIntros(u) { const n = intros.filter((x) => x.user_id === u).length; for (let k = intros.length - 1; k >= 0; k--) if (intros[k].user_id === u) intros.splice(k, 1); return n; },
    async dueIntros(nowIso) {
      return intros.filter((i) => i.follow_up_at && !i.reminded_at && ["approved", "sent"].includes(i.status) && Date.parse(i.follow_up_at) <= Date.parse(nowIso))
        .sort((a, b) => Date.parse(a.follow_up_at!) - Date.parse(b.follow_up_at!)).map((i) => { const { user_id, ...intro } = i; return { userId: user_id, intro: intro as Intro }; });
    },
  };
  return store;
}

const NOTE_SUBJECT = "A note only the person sends";
const NOTE_BODY = "Hi Lee,\n\nThis exact wording is the person's to send, never Trainee's to push.";
function seed(store: ReturnType<typeof memoryStore>, over: Partial<Intro> & { user_id?: string } = {}): Intro & { user_id: string } {
  const row = { id: 0, n: 1, route: "direct", target_name: "Maya Chen", target_company: "Ramp", target_title: "", target_ref: "your LinkedIn export",
    via_name: null, via_ref: null, to_name: "Lee Park", to_email: "lee@ramp.example", delivery: "mailto", subject: NOTE_SUBJECT, body: NOTE_BODY, blurb: null,
    payload_hash: "h", status: "sent", status_source: "person", approved_hash: "h", approved_at: iso(NOW), sent_at: iso(NOW),
    follow_up_days: 3, follow_up_at: iso(NOW - 3600_000), reminded_at: null, created_at: iso(NOW), user_id: U, ...over } as Intro & { user_id: string };
  row.id = store.introsOf.length + 1;
  store.introsOf.push(row);
  return row;
}
const sweep = (store: ReturnType<typeof memoryStore>, outbox: ReturnType<typeof memoryAlertStore>, now = NOW) =>
  runIntroReminders({ due: (t) => store.dueIntros(t), outbox, now, markReminded: async (u, n) => { await store.updateIntro(u, n, { reminded_at: iso(now) }); } });

Deno.test("intro reminders: a due reminder is queued once, as a followup, in the in-chat words, and never the note itself", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  const row = seed(store);
  eq(await sweep(store, outbox), 1);
  const dump = outbox.dump().outbox;
  eq(dump.length, 1);
  eq([dump[0].userId, dump[0].kind], [U, "followup"]);
  eq(dump[0].key, `followup:intro:${row.id}:${Date.parse(row.follow_up_at!)}`, "the key names the reminder and its due time, so a re-armed reminder is a new key");
  assert(dump[0].text.startsWith("Reminder you asked for: intro 1 to Lee Park"), dump[0].text);
  assert(!dump[0].text.includes(NOTE_SUBJECT) && !dump[0].text.includes(NOTE_BODY), "the note itself is never what gets pushed");
  eq((await store.intro(U, 1))!.reminded_at, iso(NOW), "marked reminded, so the in-chat line never repeats a pushed reminder");
  eq(await sweep(store, outbox), 0, "a second run queues nothing new");
  eq(outbox.dump().outbox.length, 1);
});

Deno.test("intro reminders: not due, already reminded, replied first, or never sent — nothing is queued", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  seed(store, { n: 1, follow_up_at: iso(NOW + 3600_000) });                                   // not yet due
  seed(store, { n: 2, reminded_at: iso(NOW - 1000) });                                          // already reminded
  seed(store, { n: 3, status: "replied", status_source: "person", follow_up_at: null });        // answered before its date: the ask is gone
  seed(store, { n: 4, status: "drafted", approved_hash: null, approved_at: null, sent_at: null }); // never approved or sent
  seed(store, { n: 5, follow_up_days: null, follow_up_at: null });                              // no reminder was ever asked for
  eq(await sweep(store, outbox), 0);
  eq(outbox.dump().outbox.length, 0);
  // an approved intro whose person asked for a nudge before sending is due exactly like a sent one (the in-chat line's rule)
  seed(store, { n: 6, status: "approved", sent_at: null });
  eq(await sweep(store, outbox), 1);
  eq(outbox.dump().outbox.length, 1);
});

Deno.test("intro reminders: a re-armed reminder queues again under its new due time", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  seed(store);
  eq(await sweep(store, outbox), 1);
  // the person arms it again (the remind verb clears reminded_at and sets a new date), and that date passes
  await store.updateIntro(U, 1, { follow_up_days: 5, follow_up_at: iso(NOW + 5 * 86400_000), reminded_at: null });
  eq(await sweep(store, outbox, NOW + 6 * 86400_000), 1);
  const keys = outbox.dump().outbox.map((o) => o.key);
  eq(keys.length, 2);
  assert(keys[0] !== keys[1], "two armings, two keys");
});

Deno.test("intro reminders: a person with no texting channel is not queued and not marked, so the in-chat line still brings it up", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  seed(store, { n: 1 });
  seed(store, { n: 1, user_id: "u-web" });
  const n = await runIntroReminders({ due: (t) => store.dueIntros(t), outbox, now: NOW, canText: async (u) => u === U, markReminded: async (u, k) => { await store.updateIntro(u, k, { reminded_at: iso(NOW) }); } });
  eq(n, 1);
  eq(outbox.dump().outbox.map((o) => o.userId), [U]);
  eq((await store.intro("u-web", 1))!.reminded_at, null, "left for the in-chat line");
});

Deno.test("intro reminders: one person's failure does not stop another's, and the run says so", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  seed(store, { n: 1 });
  seed(store, { n: 1, user_id: "u-2" });
  const flaky = { enqueue: async (u: string, m: any) => { if (u === "u-2") throw new Error("queue an alert: boom"); return outbox.enqueue(u, m); } };
  let err: any = null;
  try { await runIntroReminders({ due: (t) => store.dueIntros(t), outbox: flaky, now: NOW, markReminded: async (u, n) => { await store.updateIntro(u, n, { reminded_at: iso(NOW) }); } }); } catch (e) { err = e; }
  assert(err && /intro reminders failed for 1 of 2/.test(err.message), String(err?.message));
  eq(err.partial, 1, "the run's partial count rides the error, like the other rails");
  eq(outbox.dump().outbox.length, 1, "the first person's reminder still queued");
  eq((await store.intro("u-2", 1))!.reminded_at, null, "the failed one is left unreminded, so a later run retries it");
});

// ------------------------------------------------------------------------------------------------ the turn's copy
// PERSONALIZED OUTREACH (2026-10-31): a first email is written from the engine's payload (personal-fixture.ts).
const model = engineAware(async (p: any) => {
  const user = String(p.messages[0].content), first = /- name: (\S+)/.exec(user)?.[1] ?? "there";
  return { content: [{ type: "text", text: `Subject: A quick question\n\nHi ${first},\n\nWould you be open to a short call?` }], stop_reason: "end_turn" };
});

const facts = [{ id: "F-001", kind: "experience", text: "Data analyst intern at Acme Corp", status: "confirmed" }];
Deno.test("intro reminders: the remind reply says what the code now does — push on vs push off, and only a person with a texting channel is promised a text", async () => {
  const off = await driveToRemind(false, true);
  assert(/I can't message you first yet/.test(off) && !/text you/.test(off), off);
  const on = await driveToRemind(true, true);
  assert(!/I can't message you first yet/.test(on), on);
  assert(/I'll text you a reminder then/.test(on) && /message me first/.test(on), on);
  // review of #217/L8: a web-only person (no texting channel on record) is never told "I'll text you"
  const webOnly = await driveToRemind(true, false);
  assert(!/text you/.test(webOnly) && /I'll bring it up the next time you message me/.test(webOnly) && /haven't connected a texting app/.test(webOnly), webOnly);
  const unknown = await driveToRemind(true, undefined);
  assert(!/text you/.test(unknown), `no channel check wired: no promise of a text: ${unknown}`);
});

async function driveToRemind(introPush: boolean, texting: boolean | undefined): Promise<string> {
  const store = memoryStore();
  const deps: PeopleDeps = { store, gmail: null, fetch: (async () => new Response("no", { status: 599 })) as typeof fetch, introPush,
    ...(texting === undefined ? {} : { canText: async (u: string) => texting && u === U }) };
  const out = everyoneKnown(memoryOutreachStore()); // PERSONALIZED OUTREACH: each recipient carries one sourced fact
  const state: Record<string, unknown> = { profile: { facts } };
  const say = (message: string, extra: { attachments?: any[] } = {}) =>
    peopleTurn({ message, userId: U, threadId: T, now: NOW, state, attachments: extra.attachments, store: out, model, people: deps });
  await say("here", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: FIXTURE }] });
  eq((await say("get me an intro to Maya Chen at Ramp"))!.status, "drafted");
  eq((await say("approve intro 1"))!.status, "approved");
  eq((await say("intro 1 sent"))!.status, "sent");
  const r = await say("remind me in 2 days");
  eq(r!.status, "reminder_set", r!.reply);
  return r!.reply;
}

Deno.test("never sends: the whole intro lifecycle writes no outbox row until a reminder is armed and due — and then only the reminder", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  const deps: PeopleDeps = { store, gmail: null, fetch: (async () => new Response("no", { status: 599 })) as typeof fetch, introPush: true };
  const out = everyoneKnown(memoryOutreachStore()); // PERSONALIZED OUTREACH: each recipient carries one sourced fact
  const state: Record<string, unknown> = { profile: { facts } };
  const say = (message: string, extra: { attachments?: any[]; now?: number } = {}) =>
    peopleTurn({ message, userId: U, threadId: T, now: extra.now ?? NOW, state, attachments: extra.attachments, store: out, model, people: deps });
  await say("here", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: FIXTURE }] });
  eq((await say("get me an intro to Maya Chen at Ramp"))!.status, "drafted");
  eq((await say("approve intro 1"))!.status, "approved");
  eq((await say("intro 1 sent"))!.status, "sent");
  eq(await sweep(store, outbox), 0, "no reminder was asked for: the sweep has nothing to queue");
  eq(outbox.dump().outbox.length, 0, "drafting, approving and marking sent never touch the outbox — Trainee does not send");
  eq((await say("remind me in 2 days"))!.status, "reminder_set");
  eq(await sweep(store, outbox), 0, "armed but not yet due");
  eq(await sweep(store, outbox, NOW + 3 * 86400_000), 1, "due: exactly the reminder is queued");
  const dump = outbox.dump().outbox;
  eq(dump.length, 1);
  const saved = (await store.intro(U, 1))!;
  assert(!dump[0].text.includes(saved.body) && !dump[0].text.includes(saved.subject), "the queued text is the reminder, never the note");
});

// ------------------------------------------------------------------------------------------------ the scheduled rail
const SECRET = "z".repeat(40);
Deno.test("intro reminders: the career-proactive rail queues due reminders behind its dep, counts them, and skips the quiet", async () => {
  const store = memoryStore(), outbox = memoryAlertStore();
  seed(store, { n: 1 });
  seed(store, { n: 1, user_id: "u-2" });
  const runs: any[] = [];
  const deps = (over: Record<string, unknown> = {}) => ({
    env: { get: (k: string) => ({ CAREER_PROACTIVE_SECRET: SECRET } as Record<string, string>)[k] }, store: () => outbox, now: () => NOW,
    recentPostings: async () => [], postingsById: async () => [], recordRun: async (r: any) => { runs.push(r); },
    introReminders: { due: (t: string) => store.dueIntros(t), markReminded: async (u: string, n: number) => { await store.updateIntro(u, n, { reminded_at: iso(NOW) }); } },
    quiet: async (ids: string[]) => new Set(ids.filter((i) => i === "u-2")),
    ...over,
  });
  const post = () => new Request("https://fn.test/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRET } });
  const res = await handleProactive(post(), deps() as any);
  eq(res.status, 200);
  const body = await res.json();
  eq(body.intro_reminders, 1, "one queued; the quiet person's was not started");
  eq(outbox.dump().outbox.map((o) => o.userId), [U]);
  eq(runs.at(-1).intro_reminders, 1, "the run record counts the rail");
});
