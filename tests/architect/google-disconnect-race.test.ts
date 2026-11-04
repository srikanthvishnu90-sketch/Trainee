// Google verification (2026-10-26, review of PR #196, non-blocking: "disconnect gmail during an in-progress run leaves mail
// rows"). A mail check reads the person's Gmail, then writes what it found. If the person says "disconnect gmail" in
// between, what the check read must not be saved or said afterwards. runMail (the real scheduled run, with the real planner)
// on the memory store, whose stillConnected mirrors supabaseMailStore's (a career grant row exists); the same run on real
// Postgres is in flow-google-disconnect.test.ts. Outcome checks: rows, texts queued, cursor.
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";

const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`); };
const assert = (v: unknown, m = "assertion failed") => { if (!v) throw new Error(m); };
const NOW = Date.parse("2026-10-20T15:00:00Z"), DAY = 86400000, iso = (t: number) => new Date(t).toISOString();
const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
// A rejection from Asana: the rules are sure of it, so it becomes a status event and a text.
const REJECTION = { hash: "h1", from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application", snippet: "Unfortunately, we have decided not to move forward with your application.", date: iso(NOW - 120000), auth: AUTH };
const tracker = [{ app_id: "a1", company: "Asana", role: "Account Manager", stage: "Submitted", applied_at: iso(NOW - 10 * DAY), events: [] }];
const world = () => memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }, { user_id: "U2", read_through: iso(NOW - 3600000) }], tracker: { U1: tracker, U2: tracker } });

Deno.test("GV/R1 control: a connected person's mail is saved and said", async () => {
  const store = world(), outbox = memoryAlertStore();
  const stats = await runMail({ outbox, now: NOW, store, read: async () => ({ status: "ok", mails: [REJECTION], readThrough: NOW, listed: 1 }) });
  const d = store.dump();
  eq([d.events.U1?.length, d.events.U2?.length, d.cursors.U1, d.cursors.U2], [1, 1, NOW, NOW], "both people's event and cursor are saved");
  eq(outbox.dump().outbox.filter((o: any) => o.kind === "status").length, 2, "and each is told");
  eq(stats.disconnected, undefined, "nobody disconnected");
});

Deno.test("GV/R2 a person who disconnects while their mail is being read: nothing read is saved, queued or said; the other person is unaffected", async () => {
  const store = world(), outbox = memoryAlertStore();
  const stats = await runMail({
    outbox, now: NOW, store,
    read: async (uid) => { if (uid === "U1") store.disconnect("U1"); return { status: "ok", mails: [REJECTION], readThrough: NOW, listed: 1 }; },
  });
  const d = store.dump();
  eq([d.events.U1 ?? [], d.drafts.U1 ?? [], d.cursors.U1 ?? null], [[], [], null], "U1 disconnected mid-read: no event, no draft, no cursor");
  eq(outbox.dump().outbox.map((o: any) => [o.userId, o.kind]), [["U2", "status"]], "and the only text queued is U2's");
  eq([d.events.U2?.length, d.cursors.U2], [1, NOW], "U2 is saved as usual");
  eq(stats.disconnected, 1, "the run says one person was skipped for that");
});

Deno.test("GV/R3 a disconnect between the events and the cursor still leaves no cursor", async () => {
  const store = world();
  const base = store.record;
  // The person disconnects right after their events are saved (the second check, before drafts and cursor, catches it).
  const racing = { ...store, record: async (u: string, evs: any) => { const r = await base(u, evs); if (u === "U1") store.disconnect("U1"); return r; } };
  await runMail({ outbox: memoryAlertStore(), now: NOW, store: racing, read: async () => ({ status: "ok", mails: [REJECTION], readThrough: NOW, listed: 1 }) });
  const d = store.dump();
  eq([d.events.U1 ?? [], d.cursors.U1 ?? null], [[], null], "disconnect erased the events; the run did not write a cursor after it");
  assert(d.cursors.U2 === NOW, "U2 untouched");
});

Deno.test("GV/R4 a disconnect after the events are saved but before the drafts: the follow-up draft is not saved or queued, and the other person's is", async () => {
  const old = [{ app_id: "a9", company: "Asana", role: "Account Manager", stage: "Submitted", applied_at: iso(NOW - 20 * DAY), events: [] }];
  const store = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }, { user_id: "U2", read_through: iso(NOW - 3600000) }], tracker: { U1: old, U2: old } });
  const base = store.record, outbox = memoryAlertStore();
  const racing = { ...store, record: async (u: string, evs: any) => { const r = await base(u, evs); if (u === "U1") store.disconnect("U1"); return r; } };
  await runMail({ outbox, now: NOW, store: racing, read: async () => ({ status: "ok", mails: [], readThrough: NOW, listed: 0 }) });
  const d = store.dump();
  eq([d.drafts.U1 ?? [], d.drafts.U2?.map((x) => x.kind)], [[], ["followup"]], "U2 gets the follow-up draft (control); U1, disconnected, does not");
  eq(outbox.dump().outbox.map((o: any) => [o.userId, o.kind]), [["U2", "followup"]], "and only U2 is told");
});

Deno.test("GV/R5 a disconnect after the drafts are saved but before the read cursor: no cursor is written", async () => {
  const old = [{ app_id: "a9", company: "Asana", role: "Account Manager", stage: "Submitted", applied_at: iso(NOW - 20 * DAY), events: [] }];
  const store = memoryMailStore({ people: [{ user_id: "U1", read_through: iso(NOW - 3600000) }, { user_id: "U2", read_through: iso(NOW - 3600000) }], tracker: { U1: old, U2: old } });
  const base = store.saveDraft;
  const racing = { ...store, saveDraft: async (u: string, d: any) => { const r = await base(u, d); if (u === "U1") store.disconnect("U1"); return r; } };
  await runMail({ outbox: memoryAlertStore(), now: NOW, store: racing, read: async () => ({ status: "ok", mails: [], readThrough: NOW, listed: 0 }) });
  const d = store.dump();
  eq([d.cursors.U1 ?? null, d.cursors.U2], [null, NOW], "U1 left no cursor behind; U2's was saved");
});
