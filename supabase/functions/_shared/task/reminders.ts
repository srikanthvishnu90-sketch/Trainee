// Reminders a plan sets ("remind me Friday", "follow up in a week"): kept on the person's account (career_watch_kv key
// career:reminders, service role only, removed with the account's other keys by an erase or account deletion; no
// migration). Kept is all this does: nothing is queued on career_outbox and no message goes out on its own. Delivery is
// PR #216's (career_workflow.ts, CAREER_REMINDER_DELIVERY) and stays off until the owner turns it on; until then a
// reminder is listed back by "what reminders do I have" in #216, and its day rides the turn's meta here.
// deno-lint-ignore-file no-explicit-any

export interface Reminder { id: string; what: string; when: string; due_date: string; tz: string | null; created_at: string; source: "plan" }
export interface ReminderStore { list(userId: string): Promise<Reminder[]>; add(userId: string, r: Reminder): Promise<{ added: boolean; items: Reminder[] }> }
export const REMINDERS_KEY = "career:reminders";

const same = (a: Reminder, b: Reminder) => a.what.toLowerCase() === b.what.toLowerCase() && a.due_date === b.due_date;

export function supabaseReminderStore(admin: any): ReminderStore {
  const read = async (u: string): Promise<Reminder[]> => {
    const r = await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", REMINDERS_KEY).maybeSingle();
    if (r.error) throw new Error(`read reminders: ${r.error.message}`);
    return Array.isArray(r.data?.value?.items) ? r.data.value.items : [];
  };
  return {
    list: read,
    async add(u, rem) {
      const items = await read(u);
      // The same words for the same day again add nothing.
      if (items.some((x) => same(x, rem))) return { added: false, items };
      const next = [...items, rem];
      const w = await admin.from("career_watch_kv").upsert({ user_id: u, key: REMINDERS_KEY, value: { items: next, updated_at: new Date().toISOString() } }, { onConflict: "user_id,key" });
      if (w.error) throw new Error(`save reminder: ${w.error.message}`);
      return { added: true, items: next };
    },
  };
}

export function memoryReminderStore(): ReminderStore & { dump(): Record<string, Reminder[]> } {
  const m: Record<string, Reminder[]> = {};
  return {
    async list(u) { return [...(m[u] ?? [])]; },
    async add(u, rem) {
      const items = m[u] ?? [];
      if (items.some((x) => same(x, rem))) return { added: false, items };
      m[u] = [...items, rem];
      return { added: true, items: m[u] };
    },
    dump: () => JSON.parse(JSON.stringify(m)),
  };
}
