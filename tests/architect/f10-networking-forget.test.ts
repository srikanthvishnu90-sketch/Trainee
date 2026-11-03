// Architect ruling R1 (2026-10-27): contacts belong to the person's account (career_account_contacts), not a chat, and a
// contact the person told Trainee to forget is NEVER brought back. L7 (036219d21) wrote a chat's whole working copy back
// to the account whenever the two differed, so a chat that loaded the list before a forget put every forgotten row back
// (review of #214: 0 -> 8). Now no chat keeps a copy; a chat state saved before this that still carries `contacts` is
// moved to the account once, skipping everyone on the forgotten list. Here: forget in chat B, then chat A (holding such a
// stale copy) asks: still gone, and nothing written back. Also: one person by name; sending them again on purpose brings
// them back; a forget racing another chat's import; a write after an erase is refused; a forget the account did not
// take is never reported as done; the phrasings. In-memory stores, synthetic data.
// Run: deno test -A --no-check tests/architect/f10-networking-forget.test.ts
import nodeAssert from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
import { forgetAsk, networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore, type OutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { type ContactRow, importContactsCsv } from "../../supabase/functions/_shared/career_contacts.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
const CONTACTS = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/contacts.csv`);
const U = "u-1", NOW = Date.parse("2026-10-27T15:00:00Z");
const turn = (store: OutreachStore, threadId: string, state: Record<string, unknown>, message: string, attachments?: { name: string; text: string }[]) =>
  networkingTurn({ message, userId: U, threadId, now: NOW, state, store, model: null, ...(attachments ? { attachments } : {}) });
const names = (rows: ContactRow[]) => [...new Set(rows.map((r) => r.name))].sort();
// A chat state saved before contacts moved to the account: the export's rows in the chat itself.
const staleCopy = (): ContactRow[] => importContactsCsv("Connections.csv", LINKEDIN).rows.map((r) => ({ ...r, verified: true }));

Deno.test("R1 forget: forgotten in chat B, then chat A (holding a stale copy) asks: still gone, and never written back", async () => {
  const store = memoryOutreachStore();
  assertEquals((await turn(store, "t-a", {}, "here", [{ name: "Connections.csv", text: LINKEDIN }]))!.status, "imported");
  assertEquals(store.allContacts(U).length, 6);
  const gone = await turn(store, "t-b", {}, "forget my contacts");
  assertEquals([gone!.intent, gone!.status], ["career_contacts_forget", "forgotten"], gone!.reply);
  assertMatch(gone!.reply, /^Deleted 6 contacts from your contacts, in every conversation\./);
  assertEquals(store.allContacts(U), [], "the account holds none");
  // Chat A was saved before contacts moved to the account: its state still carries all 6 rows.
  const a: Record<string, unknown> = { contacts: staleCopy() };
  const who = await turn(store, "t-a", a, "who do I know at Ramp?");
  assertEquals(who!.status, "no_contacts", who!.reply);
  assertEquals(store.allContacts(U), [], "nothing was written back (was 0 -> 6 on L7)");
  assertEquals("contacts" in a, false, "the stale copy left the chat");
  const stripe = await turn(store, "t-c", { contacts: staleCopy() }, "email Maya at Stripe about the data analyst role");
  assertEquals(stripe!.status, "no_contacts", `a forgotten person is never a recipient: ${stripe!.reply}`);
  assertEquals(store.allContacts(U), []);
});

Deno.test("R1 forget one person by name: gone in every chat; sending them again brings them back", async () => {
  const store = memoryOutreachStore();
  await turn(store, "t-a", {}, "here", [{ name: "Connections.csv", text: LINKEDIN }, { name: "contacts.csv", text: CONTACTS }]);
  const gone = await turn(store, "t-b", {}, "please remove maya chen from my contacts");
  assertEquals(gone!.status, "forgotten", gone!.reply);
  assertMatch(gone!.reply, /^Deleted Maya Chen from your contacts, in every conversation\./);
  const who = await turn(store, "t-a", { contacts: staleCopy() }, "who do I know at Stripe");
  assertEquals(who!.status, "listed", who!.reply);
  nodeAssert.ok(!/Maya Chen/.test(who!.reply), who!.reply);
  assertMatch(who!.reply, /Lee Park/);
  assertEquals(names(store.allContacts(U)).includes("Maya Chen"), false, "not on the account, not even from the stale copy");
  assertEquals(store.forgotten(U), ["e:maya.chen@stripe.example"]);
  // One Lee Park on two lists (with and without an address) is one person: both rows go.
  assertEquals((await turn(store, "t-b", {}, "remove lee from my contacts"))!.status, "forgotten");
  assertEquals(names(store.allContacts(U)).includes("Lee Park"), false);
  assertEquals((await turn(store, "t-b", {}, "remove nobody here from my contacts"))!.status, "nothing");
  // The person sends the export again: Maya is theirs again, and no longer forgotten.
  await turn(store, "t-b", {}, "here it is again", [{ name: "Connections.csv", text: LINKEDIN }]);
  assertEquals(names(store.allContacts(U)).includes("Maya Chen"), true, "re-imported on purpose");
  assertEquals(store.forgotten(U).includes("e:maya.chen@stripe.example"), false);
  assertMatch((await turn(store, "t-a", {}, "who do I know at Stripe"))!.reply, /Maya Chen/);
});

Deno.test("R1 forget racing an import: a row of the forgotten person another chat wrote meanwhile goes too", async () => {
  const store = memoryOutreachStore();
  await turn(store, "t-a", {}, "here", [{ name: "Connections.csv", text: LINKEDIN }]);
  // Chat C imports another list with Maya Chen (same address) before chat B's forget runs.
  await turn(store, "t-c", {}, "add", [{ name: "more.csv", text: "Name,Company,Email\nMaya Chen,Stripe,maya.chen@stripe.example\nDana Lopez,Plaid,dana.lopez@plaid.example" }]);
  const gone = await turn(store, "t-b", {}, "remove maya chen from my contacts");
  assertEquals(gone!.status, "forgotten", gone!.reply);
  assertEquals(store.allContacts(U).filter((r) => r.email === "maya.chen@stripe.example"), [], "no row of Maya is left on the account");
  assertEquals(names(store.allContacts(U)).includes("Dana Lopez"), true, "the other chat's other row is kept");
});

Deno.test("R1 a forget the account did not take is never reported as done", async () => {
  const inner = memoryOutreachStore();
  await turn(inner, "t-a", {}, "here", [{ name: "Connections.csv", text: LINKEDIN }]);
  const down: OutreachStore = { ...inner, async forgetContacts() { throw new Error("store down"); } };
  const r = await turn(down, "t-b", {}, "forget my contacts");
  assertEquals([r!.intent, r!.status], ["career_contacts_forget", "not_saved"], r!.reply);
  assertMatch(r!.reply, /nothing was deleted/);
  assertEquals(inner.allContacts(U).length, 6, "still there, as the reply says");
});

Deno.test("R1 epoch guard: a turn that started before an erase writes no contacts after it", async () => {
  const store = memoryOutreachStore();
  // "forget everything" lands while the import turn is running: the epoch moves between the turn's start and its write.
  const erasing: OutreachStore = { ...store, async putContacts(u, epoch, rows, o) { store.setEpoch(U, 1); return await store.putContacts!(u, epoch, rows, o); } };
  const r = await turn(erasing, "t-a", {}, "here", [{ name: "Connections.csv", text: LINKEDIN }]);
  assertEquals(store.allContacts(U), [], "the import's rows were not written after the erase");
  assertMatch(r!.reply, /couldn't save it to your contacts just now, so nothing was imported/);
  // A stale chat copy after the erase: refused too, and dropped from the chat (it must not come back).
  const a: Record<string, unknown> = { contacts: staleCopy() };
  await turn({ ...store, async putContacts(u, _e, rows, o) { return await store.putContacts!(u, 0, rows, o); } }, "t-a", a, "who do I know at Ramp");
  assertEquals(store.allContacts(U), []);
  assertEquals("contacts" in a, false);
});

Deno.test("R1 forget asks: the phrasings people type, and what is not a forget", () => {
  for (const m of ["forget my contacts", "Delete my contacts.", "pls wipe my contact list", "clear all my connections", "ok remove my imported contacts"]) assertEquals(forgetAsk(m), { all: true }, m);
  for (const m of ["delete my linkedin connections", "forget my LinkedIn contacts", "remove my linked in export"]) assertEquals(forgetAsk(m), { linkedin: true }, m);
  assertEquals(forgetAsk("remove Maya Chen from my contacts"), { name: "maya chen" });
  for (const m of ["forget the sponsorship one", "delete everything", "remove me from your list", "who do I know at stripe", "delete draft 1"]) assertEquals(forgetAsk(m), null, m);
});
