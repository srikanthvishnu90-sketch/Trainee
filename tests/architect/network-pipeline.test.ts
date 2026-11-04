// NETWORKING PIPELINE (2026-10-30), Mapped-style parity without external accounts, for any field: "what we read", CSV import with
// sources, commonality ranking, per-contact drafts, confirm-address, send windows, pipeline notes and analytics. Pure, seeded,
// no network, no model, nothing sent.
import assertNode from "node:assert/strict";
import { Pipeline, commonalities, confirmAddress, draftAll, draftFor, editDraft, importContacts, nextSlots, profileOf, sourceVerdict, rankContacts, sendWindow, whatWeRead, withConfirmedAddress, type Fact } from "../../supabase/functions/_shared/career_network_pipeline.ts";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

const FACTS: Fact[] = [
  { kind: "school", value: "DePaul University" }, { kind: "major", value: "public health" }, { kind: "hometown", value: "Tulsa" },
  { kind: "high_school", value: "Booker T. Washington" }, { kind: "sport", value: "rowing" }, { kind: "club", value: "Pre-Health Society" },
  { kind: "interest", value: "jazz" }, { kind: "hometown", value: "Wrong City", needs_confirmation: true },
];
const CSV = `Name,Firm,Title,Email,Location,School,Hometown,High School,Sports,Interests,Orgs,Source
Maya Chen,Mayo Clinic,Program Manager,maya.chen@mayo.example,Rochester,DePaul University,Tulsa,,rowing,jazz;cooking,Pre-Health Society,alumni_export
Omar Reyes,Pfizer,Medical Writer,,New York,Northwestern,Austin,Booker T. Washington,,,,firm_team_page
Lena Fischer,Stripe,Engineer,lena@stripe.example,SF,MIT,Berlin,,,,,
Sam Park,Acme,Analyst,sam@acme.example,NYC,DePaul University,,,,,,scraped linkedin database
,Nobody,Ghost,g@x.example,,,,,,,,
Maya Chen,Mayo Clinic,Program Manager,maya.chen@mayo.example,Rochester,DePaul University,Tulsa,,rowing,,,csv
`;

Deno.test("what we read: confirmed facts only, summary, and what is missing", () => {
  const r = whatWeRead(FACTS);
  eq(r.profile.hometown, "Tulsa", "an unconfirmed fact is not read");
  ok(/you study public health at DePaul University/.test(r.text) && /from Tulsa/.test(r.text) && /rowing/.test(r.text) && /jazz/.test(r.text), r.text);
  ok(!/Wrong City/.test(r.text));
  eq(whatWeRead([]).missing.length, 0 + whatWeRead([]).missing.length);
  ok(/Tell me your school/.test(whatWeRead([]).text));
});

Deno.test("import: every contact carries a source; unsourced kinds, nameless and duplicate rows are set aside; no address is built", () => {
  const r = importContacts(CSV);
  eq(r.contacts.map((c) => c.name), ["Maya Chen", "Omar Reyes", "Lena Fischer"]);
  eq(r.contacts.map((c) => c.source), ["alumni_export", "firm_team_page", "user_csv"]);
  ok(r.contacts.every((c) => c.source_note.length > 0));
  eq(r.contacts[1].email, null); eq(r.contacts[1].address, "none", "no address was invented for Omar");
  const why = r.set_aside.map((x) => x.why).join("|");
  ok(/refused/.test(why) && /no name/.test(why) && /duplicate/.test(why), why);
});

Deno.test("ranking: hometown, sport, org, interest, school, high school, firm; most in common first; shared connection shown", () => {
  const p = profileOf(FACTS); const { contacts } = importContacts(CSV);
  const ranked = rankContacts({ ...p, employers: ["Pfizer"] }, contacts);
  eq(ranked[0].contact.name, "Maya Chen");
  eq(ranked[0].common.map((c) => c.kind).sort(), ["hometown", "interest", "org", "school", "sport"]);
  ok(/Maya Chen, Program Manager at Mayo Clinic, Rochester - shared: .*Tulsa/.test(ranked[0].line), ranked[0].line);
  eq(ranked[1].contact.name, "Omar Reyes"); eq(ranked[1].common.map((c) => c.kind).sort(), ["firm", "high_school"]);
  eq(ranked[2].score, 0); ok(/none on file/.test(ranked[2].shared));
  eq(commonalities(p, { ...contacts[0], hometown: "tulsa" }).some((c) => c.kind === "hometown"), true, "matching ignores case");
});

Deno.test("drafts: any field, name the strongest connection, invent nothing, held, hash-bound; an edit changes the hash", async () => {
  const p = profileOf(FACTS); const { contacts } = importContacts(CSV);
  const ranked = rankContacts(p, contacts);
  const { drafts, notice } = await draftAll(p, ranked, { senderName: "Vishnu", ask: "what a first year in the field looks like", attachResume: true });
  eq(drafts.length, 3); ok(/held/.test(notice) && /confirm each address/.test(notice));
  ok(drafts.every((d) => d.status === "held" && d.hash.length === 64 && !d.address_confirmed));
  const d0 = drafts[0];
  ok(/^Hi Maya,/.test(d0.body) && /we both play rowing|we are both from Tulsa/i.test(d0.body), d0.body);
  ok(!/investment|banking|analyst seat/i.test(d0.body), "not banking-only");
  ok(/public health student at DePaul University/.test(d0.body));
  ok(drafts[2].common === null && /found you through user_csv/.test(drafts[2].body), "no shared fact claimed when there is none");
  const e = await editDraft(d0, d0.body + "\nP.S. Thank you.");
  ok(e.hash !== d0.hash, "the edit changes the payload hash");
  eq((await draftFor(p, ranked[0], { senderName: "Vishnu", ask: "what a first year in the field looks like", attachResume: true })).hash, d0.hash, "deterministic");
});

Deno.test("confirm address: only the sourced address, typed back, confirms; a changed address needs the person's own typing", async () => {
  const { contacts } = importContacts(CSV);
  eq(confirmAddress(contacts[0], "MAYA.CHEN@mayo.example"), { ok: true, address: "maya.chen@mayo.example" });
  const bad = confirmAddress(contacts[0], "mchen@mayo.example"); ok(!bad.ok && /on file from/.test((bad as any).why));
  ok(!confirmAddress(contacts[0], "nope").ok);
  const p = profileOf(FACTS), r = rankContacts(p, contacts)[0];
  const d = await draftFor(p, r, { senderName: "V" });
  const c = await withConfirmedAddress(d, "maya.chen@mayo.example");
  ok(c.address_confirmed && c.to === "maya.chen@mayo.example" && c.hash.length === 64);
});

Deno.test("send windows: person's days and hours, own daily number, only approved + confirmed + unchanged drafts get a slot", async () => {
  const p = profileOf(FACTS); const { contacts } = importContacts(CSV); const ranked = rankContacts(p, contacts);
  const ds = (await draftAll(p, ranked, { senderName: "V" })).drafts;
  const conf = await Promise.all(ds.map((d) => withConfirmedAddress(d, d.to ?? "x@y.example")));
  const w = sendWindow({ days: [2, 4], startHour: 10, endHour: 14, dailyNumber: 2 });
  const now = Date.parse("2026-10-30T12:00:00Z"); // a Friday
  const ready = [{ draft: conf[0], approvedHash: conf[0].hash }, { draft: conf[1], approvedHash: conf[1].hash }, { draft: conf[2], approvedHash: conf[2].hash }];
  const r = nextSlots(ready, w, now);
  eq(r.slots.length, 3);
  for (const s of r.slots) { const t = new Date(s.at); ok([2, 4].includes(t.getUTCDay()) && t.getUTCHours() >= 10 && t.getUTCHours() < 14, s.at); ok(Date.parse(s.at) > now); }
  const perDay: Record<string, number> = {}; for (const s of r.slots) perDay[s.at.slice(0, 10)] = (perDay[s.at.slice(0, 10)] ?? 0) + 1;
  ok(Object.values(perDay).every((n) => n <= 2), JSON.stringify(perDay));
  const none = nextSlots([{ draft: ds[0], approvedHash: ds[0].hash }, { draft: conf[1], approvedHash: null }, { draft: conf[2], approvedHash: "stale" }], w, now);
  eq(none.slots, []); eq(none.skipped.map((s) => s.why), ["address not confirmed", "not approved", "changed since you approved it"]);
  eq(sendWindow({ dailyNumber: 0 }).dailyNumber, 1);
});

Deno.test("pipeline: stages forward only, notes per contact, booked chats on the calendar, analytics counts", () => {
  const pl = new Pipeline(); const t = (n: number) => `2026-11-0${n}T10:00:00Z`;
  for (const id of ["c1", "c2", "c3", "c4"]) pl.add(id, t(1));
  for (const id of ["c1", "c2", "c3"]) { pl.move(id, "approved", t(1)); pl.move(id, "sent", t(2)); }
  pl.move("c1", "replied", t(3)); pl.move("c2", "replied", t(3)); pl.move("c1", "chat_booked", t(4), "2026-11-09T15:00:00Z");
  pl.note("c1", "Likes rowing; ask about the rotation program", t(3));
  eq(pl.entries.get("c1")!.notes.length, 1);
  let threw = false; try { pl.move("c1", "sent", t(5)); } catch { threw = true; } ok(threw, "no moving back");
  threw = false; try { pl.move("c2", "chat_booked", t(5)); } catch { threw = true; } ok(threw, "a booked chat needs its time");
  eq(pl.calendar(), [{ contact_id: "c1", at: "2026-11-09T15:00:00Z" }]);
  eq(pl.analytics(), { drafted: 4, approved: 3, sent: 3, replied: 2, meetings: 1, reply_rate_pct: 66.7, meeting_rate_pct: 33.3 });
  eq(new Pipeline().analytics().reply_rate_pct, null);
});

Deno.test("no guessed addresses and no outreach: the module has no network, no send and no address builder", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/_shared/career_network_pipeline.ts", import.meta.url).pathname);
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok(!/fetch\(|XMLHttpRequest|smtp|gmail\.googleapis|\.send\(/i.test(code));
  ok(!/\$\{[^}]*\.name[^}]*\}@|firstname|first\.last/i.test(code), "no address is assembled from a name");
});

Deno.test("source gate: exact kinds and whole-string aliases only; sites and ways we never use are refused; unclear is asked", () => {
  const verdict = (raw: string) => sourceVerdict(raw, "user_csv");
  for (const k of ["user_csv", "pasted", "alumni_export", "firm_team_page", "user_linkedin_export"]) eq(verdict(k), { kind: "ok", source: k });
  eq(verdict("User LinkedIn Export"), { kind: "ok", source: "user_linkedin_export" });
  eq(verdict("alumni directory"), { kind: "ok", source: "alumni_export" });
  eq(verdict(""), { kind: "ok", source: "user_csv" }, "blank takes the file's declared kind");
  const refused = ["handshake download", "linkedin profile", "indeed profile page", "LinkedIn Sales Navigator", "sales navigator export", "scraped list", "scraped linkedin", "database", "linkedin database", "guessed from name", "inferred pattern", "apollo", "bought list", "handshake", "indeed", "linkedin.com/in/maya", "firm page scraped", "own scrape", "my own database", "own download"];
  for (const r of refused) { const v = verdict(r); ok(v.kind === "refused" || v.kind === "ask", `${r}: ${JSON.stringify(v)}`); }
  for (const r of ["handshake download", "linkedin profile", "indeed profile page", "LinkedIn Sales Navigator", "scraped list", "linkedin database", "guessed from name", "apollo", "bought list", "handshake", "indeed"]) eq(verdict(r).kind, "refused", r);
  for (const r of ["li export", "export", "own file", "download", "a friend", "page", "directory"]) eq(verdict(r).kind, "ask", r);
  eq(verdict("own download").kind, "ask", "'own' inside 'download' is no longer a match");
  // Not ASCII: compatibility forms are read as what they spell; anything else that maps to nothing is asked, never the default.
  eq(verdict("\uff4c\uff49\uff4e\uff4b\uff45\uff44\uff49\uff4e").kind, "refused", "fullwidth linkedin");
  eq(verdict("\uff4c\uff49\uff4e\uff4b\uff45\uff44\uff49\uff4e \uff45\uff58\uff50\uff4f\uff52\uff54").kind, "ok", "fullwidth reads as what it spells: the person's own linkedin export");
  eq(verdict("link\u200bedin").kind, "refused", "zero-width inside linkedin");
  eq(verdict("\u200b\u200b").kind, "ask", "only invisible characters is not blank");
  eq(verdict("   ").kind, "ok", "whitespace is blank");
  for (const r of ["\u043b\u0438\u043d\u043a\u0435\u0434\u0438\u043d", "\u0441\u0441v", "linked\u0456n", "\u9818\u82f1", "\u30ea\u30f3\u30af\u30c8\u30a4\u30f3", "\ud83d\udcc7", "\u0645\u0644\u0641", "\u200b\u0430"]) eq(verdict(r).kind, "ask", r);
  const csv = "Name,Firm,Source\nA One,X,handshake download\nB Two,Y,li export\nC Three,Z,pasted\n";
  const r = importContacts(csv);
  eq(r.contacts.map((c) => c.name), ["C Three"]);
  ok(/refused/.test(r.set_aside[0].why) && !r.set_aside[0].ask);
  ok(/unclear/.test(r.set_aside[1].why) && r.set_aside[1].ask === true);
});
