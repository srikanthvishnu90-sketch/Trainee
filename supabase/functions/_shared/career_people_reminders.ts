// Introduction reminders, pushed (D-033 as amended 2026-10-27, #217 follow-up): a reminder the person asked for
// ("remind me in 5 days") used to exist only as a line shown at their next message — nothing ever reached them if
// they stayed silent. This is the scheduled half, and it follows the same shape as every other rail: the
// career-proactive run plans AT the due time from the record as it then stands (PeopleStore.dueIntros mirrors the
// in-chat filter: armed, unreminded, still approved or sent — a reply recorded before the date clears the ask and
// nothing is queued), queues ONE text per reminder to career_outbox (kind "followup", once per key, ever), and
// marks the intro reminded so the in-chat line never repeats a pushed reminder. The run is wired only with
// CAREER_INTRO_REMINDERS=on (career-proactive/index.ts); with it off, reminders behave exactly as before (in-chat
// only, and the remind reply says so, read off the same flag).
//
// What is queued is the reminder (introReminderText: "Reminder you asked for: intro N … has no reply on record"),
// never the introduction itself: Trainee never sends an introduction (D-033) — the note is the person's to send,
// by mailto link or copied text, after hash-bound approval. Delivery from the outbox is the texting channel's job,
// as with alerts and receipts; this module proves the queueing, not the delivery.
import type { Outbox } from "./career_alert_store.ts";
import { type Intro, introReminderText } from "./career_people.ts";
import { partialError } from "./career_proactive_run.ts";

export interface IntroDueRow { userId: string; intro: Intro }

// One reminder, one key: the intro row and the due time it was armed for. Re-arming sets a new due time (and clears
// reminded_at), so a second ask queues under a second key; the same arming can never queue twice.
export const introReminderKey = (i: Intro) => `followup:intro:${i.id}:${Date.parse(i.follow_up_at!)}`;

export async function runIntroReminders(o: {
  due: (nowIso: string) => Promise<IntroDueRow[]>;
  outbox: Outbox;
  now: number;
  markReminded: (userId: string, n: number) => Promise<void>;
  // Whether the person has a texting channel the outbox delivers to. Someone without one is left alone (not queued,
  // not marked), so the in-chat line still brings the reminder up at their next message. Absent: everyone has one.
  canText?: (userId: string) => Promise<boolean>;
}): Promise<number> {
  const rows = await o.due(new Date(o.now).toISOString());
  let queued = 0;
  const failed: string[] = [];
  const reach = new Map<string, boolean>();
  for (const r of rows) {
    try {
      if (o.canText) {
        if (!reach.has(r.userId)) reach.set(r.userId, await o.canText(r.userId));
        if (!reach.get(r.userId)) continue;
      }
      const fresh = await o.outbox.enqueue(r.userId, { key: introReminderKey(r.intro), kind: "followup", text: introReminderText([r.intro]), at: o.now });
      // Queued now or queued by an earlier run that stopped before marking: either way the push has it, so the
      // in-chat line must not say it again. Only a fresh queue counts toward the run.
      await o.markReminded(r.userId, r.intro.n);
      if (fresh) queued++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failed.length) throw partialError(`intro reminders failed for ${failed.length} of ${rows.length}: ${failed[0]}`, queued);
  return queued;
}
