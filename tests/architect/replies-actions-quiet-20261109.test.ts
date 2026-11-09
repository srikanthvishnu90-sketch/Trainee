// R10 F.3 (stop/pause truth): the replies lane's approved actions are carried out only for a person who is not quiet
// (career_quiet_users: paused, texted STOP, or erased). A calendar invite emails the contact (sendUpdates=all), so a
// paused person's approved invite is held, still approved, and created once they resume. The calendar is faked here
// (no Google or Outlook call); the store is the in-memory replies store the M5 tests use.
import assertNode from "node:assert/strict";
import { memoryRepliesStore, proposeEvent, runOutreachActions, type ReplyRail } from "../../supabase/functions/_shared/career_outreach_replies.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "00000000-0000-4000-8000-00000000f301";
const NOW = Date.parse("2026-11-09T15:00:00Z");
const DAY = 86_400_000;

Deno.test("R10 F.3 replies lane: a paused person's approved calendar invite is held, not created, and goes after resume", async () => {
  const store = memoryRepliesStore();
  const created: unknown[] = [];
  const calendars = { gmail: {
    freeBusy: async () => ({ status: "ok", busy: [] }) as any,
    createEvent: async (_u: string, ev: any) => { created.push(ev); return { status: "ok", id: `ev-${created.length}`, link: "https://calendar.example/e" } as any; },
  } };
  const rail = { send: async () => { throw new Error("no email action in this test"); } } as unknown as ReplyRail;
  const id = await store.track({ user_id: U, draft_id: null, provider: "gmail", provider_thread: "th-q1", email: "avery.synthetic@beta.example", name: "Avery Synthetic", firm: "Beta", subject: "Hello", sent_at: new Date(NOW - DAY).toISOString() });
  await store.applyReply(U, id, "m-1", "wants_call", new Date(NOW).toISOString(), { who: "contact" });
  const a = (await proposeEvent({ store, userId: U, threadId: id, slot: { start: "2026-11-12T16:00:00Z", end: "2026-11-12T16:30:00Z", person: "Thu 10:00" } as any, now: NOW }))!;
  await store.approve(U, a.batch_id, [{ n: 1, hash: a.hash }], NOW);

  let paused = true;
  const quiet = async (ids: string[]) => new Set(paused ? ids.filter((x) => x === U) : []);
  const held = await runOutreachActions({ store, rail, calendars, now: NOW, worker: "w", quiet });
  eq([held.held, held.events, created.length], [1, 0, 0], "nothing is created while paused");
  const kept = (store as any).dump().actions.find((x: any) => x.id === a.id);
  eq(kept.status, "approved", "the invite stays approved for when they resume");

  // An unreadable quiet check holds everyone.
  const down = await runOutreachActions({ store, rail, calendars, now: NOW + 120_000, worker: "w", quiet: async () => { throw new Error("db down"); } });
  eq([down.held, created.length], [1, 0]);

  paused = false;
  const after = await runOutreachActions({ store, rail, calendars, now: NOW + 240_000, worker: "w", quiet });
  eq([after.events, created.length], [1, 1], "after resume the approved invite is created once");
});
