// Parity audit R10 (alerts and watches): what Trainee promised to send at a time, and what it owes the person when that
// went wrong. Pure functions; channel.ts deliverDue applies them and the stores (channel.ts memoryChannel, channel_store.ts)
// read and record the misses.
//
//   promised  a message the person was told would come at a time: a reminder they set in chat (status:reminder:...), the
//             morning job report (report:<date>), the morning brief (brief:<date>) and the weekly summary (digest:/recap:).
//             Answers, cards, receipts and single job alerts are not on a clock the person was promised.
//   late      a promised message that goes out more than LATE_MS after its time carries one first line saying it is late
//             and when it was due, on the person's clock. A row held by WhatsApp's window is not late on our side (the person
//             was told updates are waiting); a row moved past quiet hours had its time moved, and is measured from that.
//   miss      a promised message that never went out on our side: its sends failed for good, it was too old to send as news
//             (STALE_NOTE), or no channel was left to send it on (NO_CHANNEL_NOTE). The person's own choices (STOP, a pause,
//             alerts turned off, an erased account) are never misses. A miss is owned in the NEXT message the person gets,
//             as its own message right before it, once: after that message goes out the misses are recorded as owned.
//             A reminder's own text rides in the owning message (what they asked to be reminded of is not lost); a stale
//             report's postings do not (they are old news, and may be closed).
export const LATE_MS = 30 * 60_000;
export const MISS_WINDOW_MS = 14 * 86_400_000; // older misses are not raised again
export const MISS_LINES = 3; // at most this many named in one owning message; the rest are counted
export const PROMISED = /^(?:status:reminder:|report:|brief:\d{4}-\d{2}-\d{2}$|digest:|recap:)/;
export const isPromised = (key: string) => PROMISED.test(String(key ?? ""));

export interface MissRow { id: string; key: string; text: string; deliver_at: number }
// Whether an outbox row in its final state is a miss. `notes`: the delivery notes that mean "not sent on our side".
export function isMiss(r: { key: string; status: string; error?: string | null; retryAt?: number | null }, notes: readonly string[]): boolean {
  if (!isPromised(r.key)) return false;
  if (r.status === "failed") return r.retryAt === null || r.retryAt === undefined ? !/outcome unknown/i.test(String(r.error ?? "")) : false;
  if (r.status === "skipped_opt_out") return notes.includes(String(r.error ?? ""));
  return false;
}

const at = (t: number, zone: string, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleString("en-US", { timeZone: zone, ...o });
// "7:00 AM" today on the person's clock, else "Sun, Nov 1, 7:00 AM", with the zone's short name.
export function dueLabel(due: number, now: number, zone: string): string {
  const sameDay = at(due, zone, { year: "numeric", month: "numeric", day: "numeric" }) === at(now, zone, { year: "numeric", month: "numeric", day: "numeric" });
  return at(due, zone, sameDay ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
// The first line of a late promised message.
export const lateLine = (due: number, now: number, zone: string) => `Late, sorry: this was due at ${dueLabel(due, now, zone)}.`;
export const isLate = (key: string, due: number, now: number, heldAt?: number | null) => isPromised(key) && !(typeof heldAt === "number") && now - due > LATE_MS;

const dayOf = (key: string) => /^(?:report|brief):(\d{4})-(\d{2})-(\d{2})$/.exec(key);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function what(m: MissRow, now: number, zone: string): string {
  const d = dayOf(m.key), day = d ? `${MONTHS[Number(d[2]) - 1]} ${Number(d[3])}` : null;
  if (m.key.startsWith("status:reminder:")) return `your reminder for ${dueLabel(m.deliver_at, now, zone)}. Here it is: ${m.text.trim()}`;
  if (m.key.startsWith("report:")) return `your job report for ${day ?? dueLabel(m.deliver_at, now, zone)}. Those postings are old news now, so I didn't send them late; ask for new roles and you get what's open today.`;
  if (m.key.startsWith("brief:")) return `your morning brief for ${day ?? dueLabel(m.deliver_at, now, zone)}.`;
  return `your weekly summary due ${dueLabel(m.deliver_at, now, zone)}.`;
}
// The owning message: what was missed and when it was due, the reminders whole. `zoneOf` gives each row's clock.
export function missMessage(misses: readonly MissRow[], now: number, zoneOf: (m: MissRow) => string): string {
  const rows = [...misses].sort((a, b) => a.deliver_at - b.deliver_at);
  const shown = rows.slice(0, MISS_LINES), rest = rows.length - shown.length;
  if (shown.length === 1 && !rest) return `I missed something on my side: ${what(shown[0], now, zoneOf(shown[0]))}`;
  return [`I missed ${rows.length} things on my side:`, ...shown.map((m, i) => `${i + 1}. ${what(m, now, zoneOf(m))}`), ...(rest ? [`And ${rest} more from the last two weeks.`] : [])].join("\n");
}
