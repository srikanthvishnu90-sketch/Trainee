// The results-page world shared by role-pay-results*.test.ts: four synthetic postings, a memory job store, the queue the
// hash-bound Confirm writes, the person's chat outbox, sign-in fakes. No network, no database.
import { type AppRow, type FileDeps, type FileStore, handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { type ListMeta, type PostingRow, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { resultsFile, whatOf, type Picked } from "../../supabase/functions/_shared/role_results.ts";
import type { OpenQuestion, QuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { phonePost, signedIn } from "../architect/file-session-fakes.ts";

export const SECRET = "results-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
export const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
export const NOW = Date.parse("2026-11-01T15:00:00Z"), DAY = 86400000;
export const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
export const env = { get: (k: string) => ENV[k] };
export const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");

// ---------------------------------------------------------------- the postings (synthetic)
export const POSTINGS: Posting[] = [
  { job_id: "greenhouse:acme:1", provider: "greenhouse", company: "Acme Web", title: "Frontend Engineering Intern", location: "Austin, TX", url: "https://boards.greenhouse.io/acme/jobs/1",
    description: "<p>Build React components for our checkout.</p><p>Pay: $35 - $40 per hour.</p>", remote: "hybrid", posted_at: new Date(NOW - 2 * DAY).toISOString(), first_seen_at: new Date(NOW - 2 * DAY).toISOString(),
    pay: null, fitReasons: ["You listed React and TypeScript."], score: 82 },
  { job_id: "lever:globex:2", provider: "lever", company: "Globex", title: "Frontend Intern", location: "Remote", url: "https://jobs.lever.co/globex/2",
    description: "<p>Ship UI features with our design team. Summer internship.</p>", remote: "remote", posted_at: new Date(NOW - 5 * DAY).toISOString(), first_seen_at: null,
    pay: null, fitReasons: ["You listed CSS."], score: 70 },
  { job_id: "greenhouse:initech:3", provider: "greenhouse", company: "Initech", title: "UI Engineer Intern", location: "Remote", url: "https://boards.greenhouse.io/initech/jobs/3",
    description: "<p>Help build our design system.</p>", remote: "remote", posted_at: new Date(NOW - 1 * DAY).toISOString(), first_seen_at: null,
    pay: "$30/hr", fitReasons: [], score: 60 },
  { job_id: "greenhouse:hooli:4", provider: "greenhouse", company: "Hooli", title: "Frontend Intern", location: "Austin, TX", url: "https://boards.greenhouse.io/hooli/jobs/4",
    description: "<p>Frontend internship. $25/hr.</p>", remote: "onsite", posted_at: new Date(NOW - 3 * DAY).toISOString(), first_seen_at: null, pay: null, fitReasons: ["You listed React."], score: 90 },
];
export type Posting = PostingRow & { fitReasons: string[]; score: number };
export const picked = (list: Posting[] = POSTINGS): Picked[] => list.map((p) => ({
  hit: { job_id: p.job_id, company: p.company!, title: p.title!, location: p.location!, url: p.url!, first_seen_at: p.first_seen_at ?? null, role_match: true,
    fit: { score: p.score, bucket: null, excluded: false, reasons: p.fitReasons, gaps: [] }, pay: null },
  // As the live board returns it: the whole career_postings row.
  posting: { job_id: p.job_id, provider: p.provider, company: p.company!, title: p.title!, location: p.location!, url: p.url!, description: p.description!, remote: p.remote, posted_at: p.posted_at,
    first_seen_at: p.first_seen_at ?? null, pay: p.pay ?? null } as Picked["posting"],
}));
export const HASH = (n: number) => String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "a");
export const prep = (jobId: string, n: number, list: Posting[] = POSTINGS, extra: { label: string; value: string }[] = []): PreparedRow => ({ id: `33333333-3333-4333-8333-00000000000${n}`, job_id: jobId, company: list[n - 1].company!, url: list[n - 1].url!, state: "ready", card_lines: [],
  payload_hash: HASH(n), payload: { resume_sha256: "f".repeat(64), resume_name: "ada-resume.pdf", destination: list[n - 1].url, cover_note: `I'd love to build at ${list[n - 1].company}.`,
    fields: [{ name: "first_name", label: "First name", value: "Ada" }, { name: "email", label: "Email", value: "ada@example.test" }, { name: "auth", label: "Are you authorized to work in the US?", value: "Yes" },
      ...extra.map((x, i) => ({ name: `extra_${i}`, ...x }))] } });

// ---------------------------------------------------------------- the world: a memory store, the queue, the chat outbox
// postings: the board (default POSTINGS); fields: extra answers on every prepared application; clock.t: the time now; closed: job
// ids whose posting has closed since the list was made.
export function world(o: { unprepared?: string[]; postings?: Posting[]; fields?: { label: string; value: string }[] } = {}) {
  const kv = new Map<string, any>();
  const preps = new Map<string, PreparedRow>();
  const postings = o.postings ?? POSTINGS, clock = { t: NOW }, closed = new Set<string>();
  postings.forEach((p, i) => { if (!(o.unprepared ?? []).includes(p.job_id)) preps.set(p.job_id, prep(p.job_id, i + 1, postings, o.fields)); });
  const queue: { user: string; prepared_id: string; payload_hash: string; payload: Record<string, unknown>; job_id: string }[] = [];
  const outbox: { user: string; key: string; text: string }[] = [];
  const wants: string[] = [];
  // The employer's open questions (career_apply_questions) and the saves the page made.
  const qs: OpenQuestion[] = [], saved: { id: string; answer: string }[] = [], prepared: string[] = [];
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return kv.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, refs); },
    async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async rememberListMeta(u, id, m) { kv.set(`${u}|meta|${id}`, m); },
    async recallListMeta(u, id) { return (kv.get(`${u}|meta|${id}`) as ListMeta) ?? null; },
    async postings(ids) { return postings.filter((p) => ids.includes(p.job_id)).map(({ fitReasons: _f, score: _s, ...p }) => ({ ...p, closed_at: closed.has(p.job_id) ? new Date(clock.t).toISOString() : null })); },
    async save() { return "saved"; },
    async prepared(u, jobId) { return u === U ? preps.get(jobId) ?? null : null; },
    async applied(u, jobId) { return queue.some((q) => q.user === u && q.job_id === jobId); },
    async want(_u, job) { wants.push(job.job_id); return { result: "queued" }; },
    async appRow(u, jobId) {
      const q = queue.find((x) => x.user === u && x.job_id === jobId);
      return q ? { id: "j", state: "queued", reason: null, confirmation_id: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), email_confirmed_at: null, payload: q.payload, company: "x", url: "u" } as AppRow : null;
    },
    async wanted(u, url) { return u === U && wants.some((w) => postings.find((p) => p.job_id === w)?.url === url); },
  };
  const A = signedIn();
  const questions: QuestionStore = {
    async open(u) { return u === U ? qs.filter((q) => q.answer === null).map((q) => ({ ...q })) : []; },
    async countOpen(u) { return u === U ? qs.filter((q) => q.answer === null).length : 0; },
    async get(_u, ids) { return qs.filter((q) => ids.includes(q.id)); },
    async answer(u, id, answer) { if (u !== U) throw new Error("not yours"); const q = qs.find((x) => x.id === id); if (q) q.answer = answer; saved.push({ id, answer }); },
    async shown() { return null; }, async setShown() {}, async lastAssistantIntent() { return null; },
  };
  const deps: FileDeps = { ...A.deps, store, now: () => clock.t, env, questions,
    // Preparing again once the questions are answered: the computer finishes at once here, so the job has a NEW prepared row.
    reprepare: async () => { for (const [i, p] of postings.entries()) if (wants.includes(p.job_id) && !preps.has(p.job_id)) { preps.set(p.job_id, prep(p.job_id, i + 1, postings, o.fields)); prepared.push(p.job_id); } return "started" as const; },
    tap: { async card() { return null as any; }, async prepared() { return []; }, async answer() { return []; } },
    // The hash-bound approval (production: career_apply_card_confirm, one transaction bound to exactly this hash): the queue row
    // carries the prepared application whose hash was approved.
    cards: {
      async open() { throw new Error("not used: confirm is wired"); },
      async confirm(u: string, ids: string[], hashes: string[]) {
        const p = [...preps.values()].find((x) => x.id === ids[0]);
        if (!p || p.payload_hash !== hashes[0]) throw new Error("card_changed");
        queue.push({ user: u, prepared_id: p.id, payload_hash: p.payload_hash, payload: structuredClone(p.payload), job_id: p.job_id });
        return { card: { id: "card-1" }, results: [{ n: 1, company: p.company, result: "queued" }] };
      },
    } as any,
  };
  return { store, preps, queue, outbox, wants, A, deps, postings, clock, closed, qs, saved, prepared };
}
export type W = ReturnType<typeof world>;
export async function made(w: W, user = U, said = "I want frontend internships that pay $30/hr", extra: { name?: string | null; source?: "live" | "snapshot"; read?: string | null } = {}) {
  const ask = searchTextOf(said);
  const r = await resultsFile({ userId: user, now: NOW, what: whatOf({ role: ask.role, place: ask.place, remote: ask.remote, limits: ask.limits }), floor: ask.limits.pay, picked: picked(w.postings), store: w.store, ...extra,
    links: (u, l) => feedUrlsFor(env, u, l, NOW) });
  if (!r) throw new Error("the results page was not made");
  return r!;
}

// ---------------------------------------------------------------- requests the way a signed-in phone browser sends them
export const get = (w: W, s: string, query = "", init: RequestInit = {}) => handleFile(new Request(`${BASE}${query ? `?${query}` : ""}`, { ...init, headers: { cookie: `tf_s=${s}`, ...(init.headers as Record<string, string> ?? {}) } }), w.deps);
// A post with the session cookie and the page token drawn for it (file_session.ts PAGE_TOKEN). pick: the ticked "ref:tag" values.
export async function post(w: W, s: string, f: Record<string, string>, o: { pick?: string[]; headers?: Record<string, string> } = {}) {
  const init = await phonePost({ ...f, t: s }, SECRET, { headers: o.headers });
  if (o.pick?.length) init.body = String(init.body) + o.pick.map((p) => `&pick=${encodeURIComponent(p)}`).join("");
  return handleFile(new Request(BASE, init), w.deps);
}
export const textOf = async (r: Response) => plain(await r.text());
// The ref of a card by its title (and company), read from the page.
export function refIn(html: string, title: string, company?: string) {
  const card = html.split('<li class="card" id="r-').slice(1).find((c) => c.includes(`<h3 class="title">${title}</h3>`) && (!company || c.includes(`<p class="co">${company}</p>`)));
  if (!card) throw new Error(`no card for ${title}`);
  return card.slice(0, 12);
}
// One card's html.
export const cardOf = (html: string, ref: string) => html.split(`<li class="card" id="r-${ref}">`)[1]?.split("</li>")[0] ?? "";
