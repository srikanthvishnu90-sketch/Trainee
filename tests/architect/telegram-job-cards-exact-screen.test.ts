// Review fixes on the Telegram job cards: (1) the approval shows EVERYTHING the payload hash covers (a secret-looking field is
// "needs you", never silently hidden and never approvable here); (2) card Apply and Confirm run the posting screen (PR #276's
// screenPicks), so a closed or stale posting is never queued or shown for approval. Fake Telegram transport, memory stores.
import assertNode from "node:assert/strict";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { payloadLines, refOf, sendJobCards, tapJob, hashTag, type JobDeps, type JobStore, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { jobSenderFor } from "../../supabase/functions/trainee-telegram/handler.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", PID = "33333333-3333-4333-8333-333333333333", CARD = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-28T12:00:00Z"), H = "ab".repeat(32), JOB = "greenhouse:acme:1";

function tg() {
  const calls: { method: string; body: any }[] = [];
  const f = (async (u: string, init: RequestInit) => { calls.push({ method: String(u).split("/").pop()!, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true, result: { message_id: 100 + calls.length } }); }) as unknown as typeof fetch;
  return { calls, send: jobSenderFor(telegramAdapter({ token: "T", fetch: f, sleep: async () => {} }), "42") };
}
const prep = (fields: any[], extra: Record<string, unknown> = {}): PreparedRow => ({ id: PID, job_id: JOB, company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1", payload_hash: H, state: "ready", card_lines: [],
  payload: { resume_sha256: "f".repeat(64), resume_name: "ada.pdf", fields, ...extra } });
const posting = (extra: any = {}) => ({ job_id: JOB, company: "Acme", title: "Data Analyst", url: "https://boards.greenhouse.io/acme/jobs/1", first_seen_at: "2026-10-27T12:00:00Z", posted_at: "2026-10-26T12:00:00Z", description: "Analyze data.", ...extra });
function setup(o: { prepared?: PreparedRow; postings?: () => Promise<any[]> | any[] }) {
  const log = { wants: 0, opened: 0, answered: 0 };
  const store: JobStore = {
    async remember() {}, async recall(_u, _r) { return { job: { job_id: JOB, company: "Acme", title: "Data Analyst", location: "Austin", url: "https://boards.greenhouse.io/acme/jobs/1", pay: null, level: null, remote: null, posted_at: null, first_seen_at: null, deadline: null, source: null, reasons: [], gaps: [], company_domain: null }, shownAs: "text" as const }; },
    async rememberList() {}, async recallList() { return null; }, async postings() { return await (o.postings ?? (() => [posting()]))(); }, async save() { return "saved"; },
    async prepared() { return o.prepared ?? null; }, async applied() { return false; }, async want() { log.wants++; return { result: "queued" }; },
  };
  const tap: TapStore = {
    async card(_u, id) { return { id, items: [{ n: 1, prepared_id: PID, payload_hash: H }], state: "open", user_id: U } as any; },
    async prepared() { return [{ id: PID, payload_hash: H, company: "Acme" }]; },
    async answer() { log.answered++; return [{ n: 1, company: "Acme", result: "queued" }]; },
  };
  const deps: JobDeps = { store, now: () => NOW, env: { get: () => undefined }, tap, cards: { async open() { log.opened++; return { id: CARD, items: [{ n: 1, prepared_id: PID, payload_hash: H }], shown_at: new Date(NOW).toISOString() } as any; } } };
  return { deps, log };
}
const all = (t: ReturnType<typeof tg>) => t.calls.map((c) => c.body.text ?? c.body.caption ?? "").join("\n");
const buttons = (t: ReturnType<typeof tg>) => t.calls.flatMap((c) => c.body.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data as string);

Deno.test("payload lines show every field the hash covers: blank fields, non-resume files and extra keys are listed", () => {
  const lines = payloadLines(prep([
    { name: "first_name", label: "First name", value: "Ada" }, { name: "linkedin", label: "Portfolio", value: "" },
    { name: "transcript", label: "Transcript", type: "input_file", value: "t.pdf" }, { name: "cover", label: "Cover note", value: "Hi" },
  ], { referrer: "Sam", utm: { src: "tg" } }), null).join("\n");
  for (const w of ["• First name: Ada", "Left blank: Portfolio", "• Transcript: file t.pdf", "Cover note: Hi", "• referrer: Sam", `• utm: {"src":"tg"}`]) assert(lines.includes(w), `shows "${w}":\n${lines}`);
});

Deno.test("a secret-looking field with a value is 'needs you': never printed, no Confirm offered, Confirm refused", async () => {
  const p = prep([{ name: "first_name", label: "First name", value: "Ada" }, { name: "portal_password", label: "Portal password", value: "hunter2-SECRET" }, { name: "otp", label: "One-time code", value: "424242" }]);
  const lines = payloadLines(p, null).join("\n");
  assert(/Needs you/.test(lines) && lines.includes("• Portal password") && lines.includes("• One-time code"), lines);
  assert(!/hunter2|424242/.test(lines), "the secret value is never printed");
  const t = tg(), { deps, log } = setup({ prepared: p });
  const ref = await refOf(U, JOB);
  const r = await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps, send: t.send });
  eq(r.status, "needs_you");
  assert(!buttons(t).some((b) => b.startsWith("jcy:")), "no Confirm button");
  assert(!/hunter2|424242/.test(all(t)));
  const c = await tapJob({ userId: U, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps, send: t.send });
  eq([c.status, log.opened, log.answered], ["needs_you", 0, 0], "a hand-made Confirm tap cannot approve it either");
});

Deno.test("card Apply runs the posting screen: a closed posting is not queued and not shown for approval", async () => {
  const t = tg(), { deps, log } = setup({ postings: () => [posting({ closed_at: "2026-10-27T00:00:00Z" })] });
  const r = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps, send: t.send });
  eq([r.status, log.wants], ["screened", 0]);
  assert(/Not queued/.test(all(t)) && /closed/i.test(all(t)), all(t));
  const t2 = tg(), s2 = setup({ prepared: prep([{ name: "a", label: "A", value: "b" }]), postings: () => [posting({ closed_at: "2026-10-27T00:00:00Z" })] });
  const r2 = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps: s2.deps, send: t2.send });
  eq(r2.status, "screened");
  assert(!buttons(t2).some((b) => b.startsWith("jcy:")), "a closed posting's prepared application is not offered for Confirm");
});

Deno.test("card Apply refuses a stale posting, and Confirm re-screens (closed since it was shown)", async () => {
  const t = tg(), { deps, log } = setup({ postings: () => [posting({ posted_at: "2026-06-01T00:00:00Z", first_seen_at: "2026-06-02T00:00:00Z" })] });
  const r = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps, send: t.send });
  eq([r.status, log.wants], ["screened", 0]);
  const t2 = tg(), s2 = setup({ prepared: prep([{ name: "a", label: "A", value: "b" }]), postings: () => [posting({ closed_at: "2026-10-28T11:00:00Z" })] });
  const c = await tapJob({ userId: U, data: `jcy:${await refOf(U, JOB)}:${hashTag(H)}`, messageId: "1", deps: s2.deps, send: t2.send });
  eq([c.status, s2.log.opened, s2.log.answered], ["screened", 0, 0]);
});

Deno.test("the screen fails closed: if the posting row cannot be read nothing is queued", async () => {
  const t = tg(), { deps, log } = setup({ postings: () => { throw new Error("db down"); } });
  const r = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps, send: t.send });
  eq([r.status, log.wants], ["screened", 0]);
});

Deno.test("a fresh, open posting still queues through the screen", async () => {
  const t = tg(), { deps, log } = setup({});
  await sendJobCards({ userId: U, hits: [], deps, send: t.send });
  const r = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps, send: t.send });
  eq([r.status, log.wants], ["queued_unprepared", 1]);
});

Deno.test("round 6: with a confirmed-facts source wired in, an UNKNOWN fact proceeds (not held); a CONFIRMED conflict holds the Apply with the one relocation question", async () => {
  // nothing confirmed: the Apply goes through
  const t0 = tg(), s0 = setup({ postings: () => [posting({ location: "Austin, TX", description: "Analyze data. This is an in-office role." })] });
  const r0 = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps: { ...s0.deps, facts: async () => [] }, send: t0.send });
  eq([r0.status, s0.log.wants], ["queued_unprepared", 1]);
  // a confirmed home in another city + an in-office posting + relocation unknown: held, asked, not guessed
  const home = [{ id: "f1", kind: "location", text: "Lives in Chicago, IL", status: "confirmed", needs_confirmation: false, screen_key: "location" }];
  const t = tg(), { deps, log } = setup({ postings: () => [posting({ location: "Austin, TX", description: "Analyze data. This is an in-office role." })] });
  const r = await tapJob({ userId: U, data: `jca:${await refOf(U, JOB)}`, messageId: "1", deps: { ...deps, facts: async () => home }, send: t.send });
  eq([r.status, log.wants], ["screened", 0]);
  assert(/relocat/i.test(all(t)), all(t));
});
