// Job cards in Telegram (owner, 2026-10-28): "if ur texting the telegram bot I should see the postings, the companies logos,
// roles, details etc, essentially opening a file similar to instinct, login via phone number then click apply and it applies."
//
// What this file is: the postings an agent turn found, each sent as its own Telegram message (the company logo as a photo with
// the posting as its caption, or the same card as text when there is no logo); the buttons under it (Apply, Details, Save, and
// Next under a long list); and what each tap does. It is a function of its inputs (a store, a sender, a clock), so it runs
// in tests against a fake Telegram transport and a memory store.
//
// Rules that do not move:
// - Nothing on a card is invented. A line appears only when the posting (or the fit the tools computed) states it; pay, deadline
//   and level that are not listed say "not listed" or are left out.
// - Apply never sends. Tapping it shows the EXACT prepared application (the posting, the one resume it was prepared with, every
//   answer, the cover note) with Confirm / Edit / Cancel. Confirm is the hash-bound approval (D-MS-1): the button carries the
//   first 16 hex of the prepared payload's hash, the payload is read again at the tap, and a payload that changed since it was
//   shown is refused, never sent. Confirm then opens and answers a card of that one payload in ONE transaction
//   (career_apply_card_confirm_as: the same card-answer function as the Approve button), so the database re-checks the hash,
//   once, and two approvals at once cannot close each other's card in between (a store without it: open, then tapCard).
// - With no prepared application yet (the prepare worker is not connected), Apply queues the posting to be prepared and says so:
//   queued, not applied. Nothing is claimed that did not happen.
// - Only an exact duplicate (this person, this posting) blocks an application (D-MS-3). LinkedIn, Indeed and Handshake postings
//   are never automated: the card says to apply there yourself and links the posting.
// - Per-chat isolation: every button's reference is derived from the person and the posting (sha256 of "<user>|<job id>"), every
//   read is scoped to the person who tapped, and a tap from a chat that is no one's account never reaches this file.
import { answerText, type CardResult, type CardStore } from "./career_apply_cards.ts";
import { recordEvents } from "./agent/timeline.ts";
import { chatScreenFacts, contentOf } from "./career_apply_gate.ts";
import { statedFactsBefore } from "./career_account_memory.ts";
import { CareerProfile } from "./router_core.career.js";
import { screenPicks } from "./career_apply_want.ts";
import { tapCard, type TapStore } from "./channel_card_tap.ts";
import { cardDigest } from "./channel_card_tap.ts";
import { type Button } from "./channel_adapters.ts";
import { neverOpen } from "./career_people_sites.ts";

export const TG_CAPTION_MAX = 1024;
export const PAGE_SIZE = 5;
export const MASS_FROM = 3; // more than this many postings go as one link to the list page, not one card each
export const DETAILS_MAX = 3600;

export interface JobView {
  job_id: string; company: string; title: string; location: string; url: string;
  pay: string | null; level: string | null; remote: "remote" | "hybrid" | "onsite" | null;
  posted_at: string | null; first_seen_at: string | null; deadline: string | null; source: string | null;
  reasons: string[]; gaps: string[]; company_domain: string | null;
}
export interface PostingRow {
  job_id: string; provider?: string | null; company?: string; title?: string; location?: string | null; url?: string; description?: string | null;
  remote?: string | null; seniority_band?: string | null; posted_at?: string | null; first_seen_at?: string | null; pay?: string | null; closed_at?: string | null;
  deadline?: string | null; company_domain?: string | null;
}
export interface PreparedRow { id: string; job_id: string; company: string; url: string; payload: Record<string, unknown>; payload_hash: string; card_lines: string[]; state: string }

// ---------------------------------------------------------------- the store
export interface JobStore {
  remember(userId: string, ref: string, job: JobView, shownAs: "photo" | "text"): Promise<void>;
  recall(userId: string, ref: string): Promise<{ job: JobView; shownAs: "photo" | "text" } | null>;
  rememberList(userId: string, listId: string, refs: string[]): Promise<void>;
  recallList(userId: string, listId: string): Promise<string[] | null>;
  postings(jobIds: string[]): Promise<PostingRow[]>;
  save(userId: string, ref: string, job: JobView, at: number): Promise<"saved" | "already">;
  prepared(userId: string, jobId: string): Promise<PreparedRow | null>; // the person's newest ready or shown application for this posting
  applied(userId: string, jobId: string): Promise<boolean>; // an exact duplicate: this person already has this posting in the queue
  want(userId: string, job: JobView, at: number): Promise<{ result: "queued" | "already" | "refused"; reason?: string }>; // to be prepared
}

export interface JobDeps {
  store: JobStore;
  cards: Pick<CardStore, "open"> & Partial<Pick<CardStore, "confirm">>; // confirm: one card opened and answered at once (the deployed store has it)
  tap: TapStore;
  now: () => number;
  env: { get(k: string): string | undefined };
  events?: Parameters<typeof tapCard>[0]["events"];
  // The hosted feed for a list: a Telegram Mini App URL and a signed-link fallback (either null when not configured).
  feedLinks?: (userId: string, listId: string) => Promise<{ webApp: string | null; url: string | null }>;
  facts?: (userId: string) => Promise<any[]>; // the person's CONFIRMED facts, for the posting screen's knock-outs; none known = none confirmed
}

// ---------------------------------------------------------------- refs and buttons
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const refOf = async (userId: string, jobId: string) => (await hex(`${userId}|${jobId}`)).slice(0, 12);
export const hashTag = (payloadHash: string) => String(payloadHash).slice(0, 16);
const REF = /^[0-9a-f]{12}$/, TAG = /^[0-9a-f]{16}$/, LIST = /^[0-9a-f]{10}$/;
export type JobTap =
  | { op: "apply" | "details" | "save" | "edit" | "cancel"; ref: string }
  | { op: "confirm"; ref: string; tag: string }
  | { op: "next"; list: string; page: number };
export function parseJobTap(data: string): JobTap | null {
  const m = /^jc([adsxe])\:([0-9a-f]{12})$/.exec(String(data ?? ""));
  if (m && REF.test(m[2])) return { op: ({ a: "apply", d: "details", s: "save", x: "cancel", e: "edit" } as const)[m[1] as "a"], ref: m[2] };
  const y = /^jcy\:([0-9a-f]{12})\:([0-9a-f]{16})$/.exec(String(data ?? ""));
  if (y && REF.test(y[1]) && TAG.test(y[2])) return { op: "confirm", ref: y[1], tag: y[2] };
  const n = /^jcn\:([0-9a-f]{10})\:([0-9]{1,4})$/.exec(String(data ?? ""));
  if (n && LIST.test(n[1])) return { op: "next", list: n[1], page: Number(n[2]) };
  return null;
}
export const isJobTap = (data: string) => /^jc[adsxeyn]:/.test(String(data ?? ""));
export const jobButtons = (ref: string): Button[][] => [[{ text: "Apply", data: `jca:${ref}` }, { text: "Details", data: `jcd:${ref}` }, { text: "Save", data: `jcs:${ref}` }]];
export const confirmButtons = (ref: string, tag: string): Button[][] => [[{ text: "Confirm", data: `jcy:${ref}:${tag}` }, { text: "Edit", data: `jce:${ref}` }, { text: "Cancel", data: `jcx:${ref}` }]];

// ---------------------------------------------------------------- the card
const AGGREGATOR = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|workable\.com|icims\.com|jobvite\.com|linkedin\.com|indeed\.com|joinhandshake\.com|glassdoor\.com|ziprecruiter\.com|builtin\.com|wellfound\.com|bamboohr\.com|recruitee\.com|breezy\.hr|applytojob\.com|teamtailor\.com|pinpointhq\.com|jazzhr\.com|rippling\.com|taleo\.net|successfactors\.com|oraclecloud\.com|ultipro\.com|paylocity\.com|dayforcehcm\.com|adp\.com|personio\.de|join\.com|remoteok\.com|weworkremotely\.com|dice\.com|monster\.com|simplyhired\.com|careerbuilder\.com|ycombinator\.com|otta\.com|hired\.com)$/i;
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const PROVIDER_NAME: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters", workday: "Workday" };
export const sourceOf = (jobId: string, provider?: string | null) => {
  const p = String(provider || String(jobId).split(":")[0] || "").toLowerCase();
  return PROVIDER_NAME[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : null);
};
// The employer's own site, when the posting says it (company_domain) or the link is on the employer's own careers host. An
// ATS or job-board host says nothing about the employer, so no domain (and no logo) comes from it. A link's host counts as the
// employer's only when its name is the employer's name (careers.acme.com for Acme): a list of every applicant-tracking and
// job-board host can never be complete (tests/architect/scenarios-file-apply.test.ts: acme.bamboohr.com showed BambooHR's logo
// as Acme's; LinkedIn's short-link host and Indeed's UK host showed theirs).
const SECOND_LEVEL = /^(co|com|ac|org|net|gov|edu|ne|or)$/;
const registrableLabel = (h: string) => { const l = h.split("."); return l.length >= 3 && SECOND_LEVEL.test(l[l.length - 2]) && l[l.length - 1].length === 2 ? l[l.length - 3] : l[l.length - 2] ?? ""; };
const companySlug = (c: string) => String(c ?? "").toLowerCase().replace(/&/g, "and").replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|the)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
export function hostIsEmployers(h: string, company: string): boolean {
  const label = registrableLabel(h).replace(/[^a-z0-9]/g, ""), slug = companySlug(company);
  if (!label || !slug) return false;
  if (label === slug) return true;
  const first = String(company ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] ?? "";
  return (Math.min(label.length, slug.length) >= 4 && (label.includes(slug) || slug.includes(label))) || (first.length >= 4 && label.startsWith(first));
}
export function logoDomain(job: Pick<JobView, "company_domain" | "url" | "company">, env: { get(k: string): string | undefined }): string | null {
  const given = String(job.company_domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(given)) return given;
  const h = host(job.url);
  if (h && !AGGREGATOR.test(h) && !neverOpen(h)) {
    const bare = h.replace(/^(www|careers|jobs|job|apply|boards|hiring)\./, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare) && hostIsEmployers(bare, job.company)) return bare;
  }
  // Off by default: a guess from the company's name can show another company's logo.
  if ((env.get("TRAINEE_LOGO_GUESS") || "") === "on") {
    const slug = String(job.company).toLowerCase().replace(/&/g, "and").replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
    if (slug.length >= 2) return `${slug}.com`;
  }
  return null;
}
// TRAINEE_LOGO_URL: a public image URL with {domain}; the default is Google's favicon service at 128px. Only https URLs.
export function logoUrl(job: Pick<JobView, "company_domain" | "url" | "company">, env: { get(k: string): string | undefined }): string | null {
  const d = logoDomain(job, env);
  if (!d) return null;
  const tpl = (env.get("TRAINEE_LOGO_URL") || "").trim() || "https://www.google.com/s2/favicons?sz=128&domain={domain}";
  const url = tpl.split("{domain}").join(encodeURIComponent(d));
  return /^https:\/\//.test(url) ? url : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (iso: string) => { const t = Date.parse(iso); if (Number.isNaN(t)) return null; const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export function agoOf(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  const rel = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.floor(mins / 60)} h ago` : `${Math.floor(mins / 1440)} d ago`;
  return `${rel} (${dayOf(iso!)})`;
}
const clean = (s: unknown, n: number) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, n);

// The posting as the tools found it, joined with the stored posting row for what the search result does not carry.
export function jobViewOf(hit: any, row: PostingRow | null | undefined): JobView {
  const level = clean(row?.seniority_band ?? hit?.level ?? "", 40);
  const remote = row?.remote === "remote" || row?.remote === "hybrid" || row?.remote === "onsite" ? row.remote : null;
  const fit = hit?.fit && typeof hit.fit === "object" ? hit.fit : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => clean(x, 160)).filter(Boolean).slice(0, 4) : []);
  return {
    job_id: String(hit?.job_id ?? row?.job_id ?? ""), company: clean(hit?.company ?? row?.company, 120), title: clean(hit?.title ?? row?.title, 160),
    location: clean(hit?.location ?? row?.location, 120), url: String(hit?.url ?? row?.url ?? ""),
    pay: clean(hit?.pay ?? row?.pay, 120) || null, level: level || null, remote,
    posted_at: row?.posted_at ?? null, first_seen_at: row?.first_seen_at ?? hit?.first_seen_at ?? null,
    deadline: row?.deadline ?? hit?.deadline ?? null, source: sourceOf(String(hit?.job_id ?? row?.job_id ?? ""), row?.provider),
    reasons: list(fit.reasons), gaps: list(fit.gaps), company_domain: row?.company_domain ?? hit?.company_domain ?? null,
  };
}

// Plain text (no parse mode, nothing to escape). Every line is a stated fact or an honest "not listed".
export function captionOf(job: JobView, now: number): string {
  const where = [job.location, job.remote === "remote" ? "Remote" : job.remote === "hybrid" ? "Hybrid" : job.remote === "onsite" ? "On-site" : ""].filter(Boolean);
  const dedup = where.filter((w, i) => where.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i);
  const posted = agoOf(job.posted_at, now), seen = agoOf(job.first_seen_at, now);
  // Company first, then the role: a list scans by employer. A fact the posting does not state is left out, not listed as "not listed".
  const lines = [
    job.company, job.title, ...(dedup.length ? [dedup.join(" · ")] : []), "",
    ...(job.pay ? [`Pay: ${job.pay}`] : []),
    ...(job.level ? [`Level: ${job.level}`] : []),
    ...(posted ? [`Posted: ${posted}`] : seen ? [`First seen: ${seen}`] : []),
    ...(job.deadline && dayOf(job.deadline) ? [`Apply by: ${dayOf(job.deadline)}`] : []),
    ...(job.source ? [`Source: ${job.source}`] : []),
    ...(job.reasons.length ? ["", "Why it fits you:", ...job.reasons.slice(0, 3).map((r) => `• ${r}`)] : []),
    ...(job.gaps.length ? ["Gaps:", ...job.gaps.slice(0, 2).map((r) => `• ${r}`)] : []),
  ];
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return text.length <= TG_CAPTION_MAX ? text : `${text.slice(0, TG_CAPTION_MAX - 1)}…`;
}

// The requirements section of the posting's own text when it has one; otherwise the start of the text, said so.
export function requirementsOf(description: string | null | undefined): { label: string; text: string } | null {
  const raw = String(description ?? "").replace(/<\/(p|li|h\d|div|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  const plain = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  if (!plain) return null;
  const m = /(^|\n)\s*(requirements|qualifications|minimum qualifications|basic qualifications|what you(?:'|’)ll need|what we(?:'|’)re looking for|who you are|about you|you have|must have)[^\n]{0,40}\n/i.exec(plain);
  if (m) return { label: "Requirements", text: plain.slice(m.index + m[0].length).trim() };
  return { label: "Posting text", text: plain };
}
export function detailsOf(job: JobView, row: PostingRow | null | undefined, now: number): string[] {
  const head = [captionOf({ ...job, reasons: [], gaps: [] }, now), job.url ? `\nLink: ${job.url}` : ""].join("");
  const req = requirementsOf(row?.description);
  const body = req ? `${req.label}:\n${req.text}` : "The full posting text is not on file; open the link above.";
  const all = `${head}\n\n${body}`;
  const out: string[] = [];
  let rest = all;
  while (rest.length > DETAILS_MAX) {
    let cut = rest.lastIndexOf("\n", DETAILS_MAX);
    if (cut < DETAILS_MAX / 2) cut = rest.lastIndexOf(" ", DETAILS_MAX);
    if (cut < 1) cut = DETAILS_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------- sending
export interface JobSender {
  photo(a: { photoUrl: string; caption: string; buttons: Button[][] }): Promise<{ ok: boolean }>;
  text(a: { text: string; buttons?: Button[][]; replyTo?: string | null }): Promise<{ ok: boolean; id?: string | null }>;
  edit?(a: { messageId: string; text: string; buttons?: Button[][]; caption?: boolean }): Promise<{ ok: boolean }>;
}
const listIdOf = async (userId: string, refs: string[], now: number) => (await hex(`${userId}|${refs.join(",")}|${now}`)).slice(0, 10);

// One page of the list: each posting its own message, then (when more follow) "Showing a-b of n" with Next. Returns how many went.
export async function sendJobPage(o: { userId: string; jobs: JobView[]; page: number; listId: string; deps: JobDeps; send: JobSender }): Promise<{ sent: number; photo: number; text: number }> {
  const { deps, send } = o;
  const from = o.page * PAGE_SIZE, slice = o.jobs.slice(from, from + PAGE_SIZE);
  let photo = 0, text = 0;
  for (const job of slice) {
    const ref = await refOf(o.userId, job.job_id);
    const lastOfPage = job === slice[slice.length - 1] && from + PAGE_SIZE < o.jobs.length;
    const left = o.jobs.length - (from + PAGE_SIZE);
    const caption = captionOf(job, deps.now()), logo = logoUrl(job, deps.env);
    const buttons: Button[][] = [...jobButtons(ref), ...(lastOfPage ? [[{ text: `Next ${Math.min(PAGE_SIZE, left)} of ${left} more`, data: `jcn:${o.listId}:${o.page + 1}` }]] : [])];
    let shownAs: "photo" | "text" = "text";
    if (logo) { const r = await send.photo({ photoUrl: logo, caption, buttons }).catch(() => ({ ok: false })); if (r.ok) { shownAs = "photo"; photo++; } }
    if (shownAs === "text") {
      const r = await send.text({ text: `${caption}${job.url ? `\n\n${job.url}` : ""}`.slice(0, 4000), buttons });
      if (r.ok) text++;
      else continue; // not delivered: no card is remembered for a button nobody can tap
    }
    await deps.store.remember(o.userId, ref, job, shownAs);
  }
  return { sent: photo + text, photo, text };
}

// The postings an agent turn found, as cards: the first page now, the whole list remembered for Next. The rows the search
// result does not carry (level, posted date, source, requirements) are read once, bounded, from the stored postings.
export async function sendJobCards(o: { userId: string; hits: any[]; deps: JobDeps; send: JobSender }): Promise<{ sent: number; total: number }> {
  const hits = (o.hits ?? []).filter((h) => h && typeof h.job_id === "string" && h.job_id && /^https?:\/\//i.test(String(h.url ?? "")));
  if (!hits.length) return { sent: 0, total: 0 };
  const rows = new Map<string, PostingRow>();
  try { for (const r of await o.deps.store.postings(hits.map((h) => h.job_id).slice(0, 200))) rows.set(r.job_id, r); } catch { /* the cards still go, with what the search gave */ }
  const jobs = hits.map((h) => jobViewOf(h, rows.get(h.job_id)));
  const refs = await Promise.all(jobs.map((j) => refOf(o.userId, j.job_id)));
  const listId = await listIdOf(o.userId, refs, o.deps.now());
  // The whole list is remembered up front (with each job), so Next never depends on the page that was shown first.
  await o.deps.store.rememberList(o.userId, listId, refs);
  for (let i = 0; i < jobs.length; i++) await o.deps.store.remember(o.userId, refs[i], jobs[i], "text");
  // APPLY HERE (apply_here.ts): the postings the person pasted or pointed at, each with ONE Apply button; several go as one list link.
  if (hits.every((h) => h.apply_here === true)) return await sendApplyHere({ userId: o.userId, jobs, refs, notChecked: hits.map((h) => (Array.isArray(h.not_checked) ? h.not_checked : []) as string[]), listId, deps: o.deps, send: o.send });
  // A mass list is one short line and the link (Telegram shows the link's preview card): the rows, with Apply on each, are on the page.
  if (jobs.length > MASS_FROM && o.deps.feedLinks) {
    const links = await o.deps.feedLinks(o.userId, listId).catch(() => null);
    if (links?.url || links?.webApp) {
      const line = `${jobs.length} jobs for you.${links.url ? ` Open the list: ${links.url}` : ""}`;
      const r = await o.send.text({ text: line, buttons: links.webApp ? [[{ text: "Open the list", webApp: links.webApp }]] : undefined });
      if (r.ok) return { sent: 1, total: jobs.length };
    }
  }
  const r = await sendJobPage({ userId: o.userId, jobs, page: 0, listId, deps: o.deps, send: o.send });
  return { sent: r.sent, total: jobs.length };
}

// ---------------------------------------------------------------- apply here: ONE button
// With a prepared application the button is the hash-bound approval itself (jcy: the tag of the payload shown; the tap re-reads it, a
// changed one is refused); the text is the exact payload summary. With none (no worker host yet) the button queues the posting and
// the tap says "Queued", which is all that is true. Several postings: one list link (the hosted page has Apply on each row and one
// "Apply to all N" bound to the exact set); without a link configured, each posting gets its own one-button message.
export async function sendApplyHere(o: { userId: string; jobs: JobView[]; refs: string[]; notChecked: string[][]; listId: string; deps: JobDeps; send: JobSender }): Promise<{ sent: number; total: number }> {
  const { jobs, refs, deps, send } = o;
  if (jobs.length > 1 && deps.feedLinks) {
    const links = await deps.feedLinks(o.userId, o.listId).catch(() => null);
    if (links?.url || links?.webApp) {
      const r = await send.text({ text: `${jobs.length} postings ready. Open the list: Apply on each, or Apply to all ${jobs.length}.${links.url ? `\n${links.url}` : ""}`, buttons: links.webApp ? [[{ text: "Open the list", webApp: links.webApp }]] : undefined });
      if (r.ok) return { sent: 1, total: jobs.length };
    }
  }
  let sent = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i], ref = refs[i];
    const prep = await deps.store.prepared(o.userId, job.job_id).catch(() => null);
    const nc = o.notChecked[i]?.length ? `Not checked: ${o.notChecked[i].join(", ")}.` : "";
    if (prep && secretFields(prep).length) {
      const r = await send.text({ text: `${job.title ? `${job.title} at ` : ""}${job.company}: this one has a field that needs you (a password, code or similar), and those never go through chat. Finish it yourself:\n${prep.url}` });
      if (r.ok) sent++;
      continue;
    }
    const lines = prep
      ? [...payloadLines(prep, job).slice(0, -2), ...(nc ? [nc] : []), "", "Tap Apply to approve exactly this. Nothing else is sent."]
      : [captionOf({ ...job, reasons: [], gaps: [] }, deps.now()), ...(nc ? ["", nc] : []), "", "Not prepared yet. Tap Apply to queue it; nothing is sent to the employer until you approve the exact application."];
    const pages = pageLines(lines);
    for (let k = 0; k < pages.length; k++) {
      const last = k === pages.length - 1;
      const r = await send.text({ text: pages[k], buttons: last ? [[{ text: "Apply", data: prep ? `jcy:${ref}:${hashTag(prep.payload_hash)}` : `jca:${ref}` }]] : undefined });
      if (last && r.ok) sent++;
    }
  }
  return { sent, total: jobs.length };
}

// ---------------------------------------------------------------- the exact payload
// What counts as a secret, anywhere the payload hash covers (every field's name / label / type / id / placeholder / autocomplete,
// every key at any depth of the payload, every card line, and values that look like a card number, SSN or API key):
const SECRETISH = /\bpass(?:word|wd|code|phrase|port)?\b|passw|secret|token|\botp\b|one[- ]?time|\b[2m]fa\b|verification[- ]?code|security[- ]?code|\bssn\b|social[- ]?security|card[- ]?number|\bcc[- ]?num|\bcvv\b|\bcvc\b|api[-_ ]?key|credential|bearer|private[-_ ]?key|auth[-_ ]?code|sign[-_ ]?in[-_ ]?code/i;
const SECRET_TYPE = /^(?:password|passwd|secret|otp|one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)$/i;
const luhn = (d: string) => { let n = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let x = Number(d[i]); if (alt) { x *= 2; if (x > 9) x -= 9; } n += x; alt = !alt; } return n % 10 === 0; };
const secretValue = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return false;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(t)) return true; // an SSN
  if (/^bearer\s+\S{8,}/i.test(t) || /^(?:sk|pk|rk|ghp|gho|xox[abprs]|eyJ)[-_A-Za-z0-9.]{16,}$/.test(t)) return true; // a token / key
  for (const m of t.matchAll(/(?:\d[ -]?){13,19}/g)) { const d = m[0].replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) return true; } // a card number
  return false;
};
const hasValue = (v: unknown) => v !== null && v !== undefined && (typeof v === "string" ? v.trim() !== "" : typeof v === "object" ? Object.keys(v as object).length > 0 : true);
const isSecretish = (f: any) => SECRET_TYPE.test(String(f?.type ?? "").trim()) || SECRETISH.test(`${f?.name ?? ""} ${f?.label ?? ""} ${f?.id ?? ""} ${f?.key ?? ""} ${f?.placeholder ?? ""} ${f?.autocomplete ?? ""} ${f?.kind ?? ""} ${f?.type ?? ""}`);
// A field the person must fill in themselves: a secret-looking name, label or type (even while it is empty), or a value that looks like one.
export const isSecretField = (f: any) => isSecretish(f) || (hasValue(f?.value) && secretValue(f?.value));
// A top-level payload key (other than the form's fields) that names a secret with a value, or holds one at any depth.
export function secretKey(k: string, v: unknown): boolean { if (SECRETISH.test(k) && hasValue(v)) return true; if (BOOKKEEPING.has(k)) return false; const sub: string[] = []; secretPaths(v, k, sub); return sub.length > 0; }
// The payload's own bookkeeping (who, which posting, which resume file by its hash, when it expires): never a secret, so never scanned for
// secret-looking VALUES (a resume's sha256 or an account id with a long run of digits passes the card-number check about one time in a
// hundred, which made every application carrying it "needs you"). Their keys are still checked.
const BOOKKEEPING = new Set(["version", "user_id", "job_id", "company", "url", "title", "resume_sha256", "privacy_epoch", "account_version", "expires_at", "kind"]);
// Any key at any depth that names a secret and carries a value, or any value that looks like one: the path to it (never the value).
function secretPaths(v: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 6 || v === null || v === undefined) return;
  if (Array.isArray(v)) { v.forEach((x, i) => { if (x && typeof x === "object" && !Array.isArray(x) && isSecretish(x) && hasValue((x as any).value)) out.push(`${path}[${i}]`); else secretPaths(x, `${path}[${i}]`, out, depth + 1); }); return; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRETISH.test(k) && hasValue(x)) out.push(path ? `${path}.${k}` : k);
      else secretPaths(x, path ? `${path}.${k}` : k, out, depth + 1);
    }
    return;
  }
  if (secretValue(v)) out.push(path || "a value");
}
const secretLine = (l: string) => (SECRETISH.test(l) && (/[:=]\s*\S/.test(l) || /\b\d{4,}\b/.test(l))) || secretValue(l);
// Everything the payload hash covers is shown here, in the person's words, or the application is not offered for Confirm:
//   * every field with a value is listed (a file field as "file <name>"); blank fields are listed together as "Left blank";
//   * every other top-level key of the payload is listed with its value;
//   * a field, key or card line that looks like a secret (password-type input, one-time code, token, SSN, card number) is NEVER
//     printed and NEVER approved here: it is listed as "needs you", and an application with such a thing carrying a value gets no
//     Confirm button (the person types it into the employer's own form themselves; no password or code goes through chat).
export function secretFields(p: PreparedRow): string[] {
  const pl: any = p.payload ?? {};
  const out: string[] = [];
  const fields: any[] = Array.isArray(pl.fields) ? pl.fields : [];
  fields.forEach((f, i) => { if (isSecretish(f) && hasValue(f?.value)) out.push(clean(f.label ?? f.name, 120) || `field ${i + 1}`); else if (f && hasValue(f?.value) && secretValue(f.value)) out.push(clean(f.label ?? f.name, 120) || `field ${i + 1}`); });
  for (const [k, v] of Object.entries(pl)) { if (k === "fields") continue; const sub: string[] = []; if (SECRETISH.test(k) && hasValue(v)) sub.push(k); else if (!BOOKKEEPING.has(k)) secretPaths(v, k, sub); out.push(...sub.map((x) => clean(x, 120))); }
  (Array.isArray(p.card_lines) ? p.card_lines : []).forEach((l, i) => { if (secretLine(String(l ?? ""))) out.push(`card line ${i + 1}`); });
  return out;
}
export function payloadLines(p: PreparedRow, job: JobView | null): string[] {
  const pl = p.payload ?? {};
  const fields: any[] = Array.isArray(pl.fields) ? pl.fields : [];
  const sha = /^[a-f0-9]{64}$/.test(String(pl.resume_sha256 ?? "")) ? String(pl.resume_sha256) : null;
  const resumeName = clean((pl as any).resume_name ?? (pl as any).resume_file ?? "", 120);
  const isCover = (f: any) => /cover/i.test(`${f?.name ?? ""} ${f?.label ?? ""}`);
  const isFile = (f: any) => /file/i.test(String(f?.type ?? ""));
  const has = (f: any) => !!String(f?.value ?? "").trim();
  const name = (f: any) => clean(f?.label ?? f?.name, 200) || "(unnamed field)";
  const cover = fields.find((f) => isCover(f) && !isFile(f) && !isSecretish(f) && !secretValue(f.value) && has(f));
  const looksSecret = (f: any) => isSecretish(f) || (has(f) && secretValue(f.value));
  const secret = fields.filter(looksSecret);
  const answers = fields.filter((f) => f !== cover && !looksSecret(f) && has(f));
  const blank = fields.filter((f) => !looksSecret(f) && !has(f));
  const shown = new Set(["fields", "resume_sha256", "resume_name", "resume_file", "title"]);
  const extraAll = Object.entries(pl).filter(([k]) => !shown.has(k));
  const extraSecret: string[] = [];
  const extra = extraAll.filter(([k, v]) => { const sub: string[] = []; if (SECRETISH.test(k) && hasValue(v)) sub.push(k); else if (!BOOKKEEPING.has(k)) secretPaths(v, k, sub); if (sub.length) { extraSecret.push(...sub); return false; } return true; });
  const cardLines = (Array.isArray(p.card_lines) ? p.card_lines : []).map((l) => String(l ?? ""));
  const cardSecret = cardLines.filter(secretLine).length;
  const needsYou = [...secret.map(name), ...extraSecret.map((x) => clean(x, 120)), ...(cardSecret ? [`${cardSecret} line${cardSecret > 1 ? "s" : ""} of the card (left out)`] : [])];
  const title = job?.title ?? clean((pl as any).title ?? "", 160);
  const val = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return [
    `Application for your approval`,
    `Posting: ${title ? `${title} at ` : ""}${p.company}`,
    `Link: ${p.url}`,
    `Resume: ${resumeName ? `${resumeName} ` : ""}${sha ? `(sha256 ${sha.slice(0, 12)}...) , the one resume this was prepared with` : "none attached"}`,
    `Cover note: ${cover ? String(cover.value).trim() : "none"}`,
    answers.length ? "Answers:" : "Answers: none",
    ...answers.map((f) => (isFile(f) ? `• ${name(f)}: file ${String(f.value).trim()}` : `• ${name(f)}: ${String(f.value).trim()}`)),
    ...(blank.length ? [`Left blank: ${blank.map(name).join("; ")}`] : []),
    ...(needsYou.length ? ["Needs you (I never type or send these; fill them in yourself on the employer's form):", ...needsYou.map((x) => `• ${x}`)] : []),
    ...(extra.length ? ["Also in this application:", ...extra.map(([k, v]) => `• ${clean(k, 80)}: ${val(v)}`)] : []),
    ...(cardLines.filter((l) => !secretLine(l)).length ? ["", "As the card reads:", ...cardLines.filter((l) => !secretLine(l)).map((l) => `• ${l}`)] : []),
    "", "Nothing is sent until you tap Confirm. Edit changes it; Cancel drops it.",
  ];
}
function pageLines(lines: string[], max = 3800): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of lines) {
    for (let line = raw; ; ) {
      const piece = line.slice(0, max);
      if (buf && buf.length + 1 + piece.length > max) { out.push(buf); buf = ""; }
      buf = buf ? `${buf}\n${piece}` : piece;
      line = line.slice(max);
      if (!line) break;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------------------------------------------------------- taps
export interface JobTapResult { toast: string; status: string }
export const BLOCKED_HOST = /(^|\.)(linkedin\.com|indeed\.com|joinhandshake\.com)$/i;
export const GONE_REPLY = "That card is too old for me to open. Ask me for the postings again and I'll send fresh ones.";
export const NO_WORKER_REPLY = (company: string, title: string) =>
  `Queued: ${title ? `${title} at ` : ""}${company}. We haven't started it yet and nothing has gone to the employer. When it's ready I'll show you the exact application to approve.`;
export const QUEUED_REPLY = (company: string, title: string) =>
  `Approved: ${title ? `${title} at ` : ""}${company}, exactly as shown. Queued, not submitted yet. I'll tell you what comes back.`;

// The posting screen (career_apply_gate.ts via screenPicks, PR #276) for a card tap: a closed, stale, scam-looking or knock-out
// posting is never queued and never shown for approval. The stored posting row is read fresh at the tap; if it cannot be read
// the tap fails closed (nothing queued) rather than skipping the screen.
export async function screenedOut(userId: string, job: JobView, deps: JobDeps): Promise<string | null> {
  let row: PostingRow | null;
  const UNREADABLE = "I couldn't check that posting just now (it may have closed), so nothing was queued. Tap Apply again in a minute.";
  try { row = (await deps.store.postings([job.job_id]))[0] ?? null; } catch { return UNREADABLE; }
  if (!row) return UNREADABLE; // no row on file is an unreadable posting, not a clean one: fail closed
  const facts = await (deps.facts?.(userId) ?? Promise.resolve([])).catch(() => []);
  return postingVerdict(job, row, facts, !!deps.facts, deps.now());
}
// The same screen as a pure verdict over a posting row already read (the list page screens every row it offers with one read).
export function postingVerdict(job: JobView, row: PostingRow, facts: any[], factsWired: boolean, now: number): string | null {
  const content = contentOf(row);
  const r = screenPicks([{ job_id: job.job_id, url: job.url, company: job.company, title: job.title, location: job.location, content }], { apps: [], facts, now });
  if (r.ok.length) return null;
  // Without a confirmed-facts source wired in (deps.facts), a "held until you confirm a fact" result is not a verdict about the
  // posting; closed, stale and scam-looking still stop it. With the source wired in, a held posting is stopped and the ask shown.
  const hard = factsWired ? r.refused : r.refused.filter((x) => x.ask !== "fact");
  if (!hard.length) return null;
  return hard[0].said ?? "that posting didn't pass the posting screen";
}
// LinkedIn, Indeed and Handshake on any suffix or spelling of their host (a trailing-dot host, the short-link host, a country domain): never automated.
export const byHandHost = (h: string) => BLOCKED_HOST.test(h) || neverOpen(h);
export const byHandUrl = (u: string) => { try { return byHandHost(new URL(u).hostname); } catch { return false; } };

export async function tapJob(o: { userId: string; data: string; messageId: string | null; deps: JobDeps; send: JobSender }): Promise<JobTapResult> {
  const t = parseJobTap(o.data);
  const { deps, send, userId } = o;
  const say = async (text: string, buttons?: Button[][]) => { await send.text({ text, buttons }); };
  if (!t) return { toast: "That button no longer works.", status: "unknown" };

  if (t.op === "next") {
    const refs = await deps.store.recallList(userId, t.list).catch(() => null);
    if (!refs) { await say(GONE_REPLY); return { toast: "Too old.", status: "gone" }; }
    const jobs: JobView[] = [];
    for (const r of refs) { const got = await deps.store.recall(userId, r).catch(() => null); if (got) jobs.push(got.job); }
    if (t.page * PAGE_SIZE >= jobs.length) return { toast: "That was the last page.", status: "end" };
    await sendJobPage({ userId, jobs, page: t.page, listId: t.list, deps, send });
    return { toast: `Page ${t.page + 1}`, status: "next" };
  }

  const got = await deps.store.recall(userId, t.ref).catch(() => null);
  if (!got) { await say(GONE_REPLY); return { toast: "Too old.", status: "gone" }; }
  const { job, shownAs } = got;

  if (t.op === "details") {
    const rows = await deps.store.postings([job.job_id]).catch(() => [] as PostingRow[]);
    const parts = detailsOf(job, rows[0] ?? null, deps.now());
    // A text card expands in place (the one message grows); a photo card's caption holds 1,024 characters, so its details
    // follow as a reply under it.
    if (shownAs === "text" && parts.length === 1 && send.edit && o.messageId) {
      const r = await send.edit({ messageId: o.messageId, text: parts[0], buttons: jobButtons(t.ref) });
      if (r.ok) return { toast: "Details", status: "details" };
    }
    for (let i = 0; i < parts.length; i++) await send.text({ text: parts[i], buttons: i === parts.length - 1 ? jobButtons(t.ref) : undefined, replyTo: i === 0 ? o.messageId : null });
    return { toast: "Details", status: "details" };
  }

  if (t.op === "save") {
    const r = await deps.store.save(userId, t.ref, job, deps.now());
    return { toast: r === "saved" ? "Saved." : "Already saved.", status: r };
  }

  if (t.op === "cancel") { await say(`Dropped. Nothing was sent for ${job.title ? `${job.title} at ` : ""}${job.company}.`); return { toast: "Cancelled.", status: "cancelled" }; }
  if (t.op === "edit") {
    await say(`Tell me what to change for ${job.title ? `${job.title} at ` : ""}${job.company} (the cover note, an answer, which resume), in your own words. I'll prepare it again and show the new version with a fresh Confirm; the old Confirm stops working the moment it changes.`);
    return { toast: "Tell me what to change.", status: "edit" };
  }

  if (t.op === "apply") {
    const h = (() => { try { return new URL(job.url).hostname; } catch { return ""; } })();
    if (byHandHost(h)) {
      await say(`I don't apply on LinkedIn, Indeed or Handshake for you. Open it and apply there yourself:\n${job.url}`);
      return { toast: "Apply there yourself.", status: "never_automated" };
    }
    if (await deps.store.applied(userId, job.job_id).catch(() => false)) {
      await say(`You already have ${job.title ? `${job.title} at ` : ""}${job.company} in your applications, so I won't queue it twice. Say "show my applications" for where it stands.`);
      return { toast: "Already applied.", status: "duplicate" };
    }
    const screened = await screenedOut(userId, job, deps);
    if (screened) { await say(`Not queued: ${screened}`); return { toast: "Not queued.", status: "screened" }; }
    const prep = await deps.store.prepared(userId, job.job_id).catch(() => null);
    if (!prep) {
      const w = await deps.store.want(userId, job, deps.now()).catch(() => ({ result: "refused" as const, reason: "I couldn't save that just now. Tap Apply again in a minute." }));
      if (w.result === "refused") { await say(`Not queued: ${w.reason ?? "I can't open that posting's application form yet."}`); return { toast: "Not queued.", status: "refused" }; }
      await say(w.result === "already" ? `${NO_WORKER_REPLY(job.company, job.title)} (It was already waiting.)` : NO_WORKER_REPLY(job.company, job.title));
      return { toast: "Queued, not applied.", status: "queued_unprepared" };
    }
    const lines = pageLines(payloadLines(prep, job));
    const needsYou = secretFields(prep).length > 0; // a secret-looking field with a value: shown as "needs you", never approvable here
    for (let i = 0; i < lines.length; i++) await send.text({ text: lines[i], buttons: i === lines.length - 1 && !needsYou ? confirmButtons(t.ref, hashTag(prep.payload_hash)) : undefined });
    if (needsYou) { await say(`I can't send this one from here: it has a field that needs you (a password, code or similar), and those never go through chat. Open the link and finish that part yourself:\n${prep.url}`); return { toast: "Needs you.", status: "needs_you" }; }
    return { toast: "Check it, then Confirm.", status: "shown" };
  }

  // Confirm: the hash-bound approval. The payload is read again now; the tag on the button must be the tag of what is on file.
  if (t.op === "confirm") {
    // Already in the applications (approved by another tap at the same moment, on another device, or sent elsewhere): that is
    // what is said, never "changed" or "could not open": the payload it approved is no longer a ready one, so check this first,
    // and again whenever the approval below finds the prepared application gone.
    const applied = () => deps.store.applied(userId, job.job_id).catch(() => false);
    const duplicate = async (): Promise<JobTapResult> => {
      await say(`You already have ${job.company} in your applications, so I won't queue it twice.`);
      return { toast: "Already applied.", status: "duplicate" };
    };
    if (await applied()) return duplicate();
    const prep = await deps.store.prepared(userId, job.job_id).catch(() => null);
    if (!prep || hashTag(prep.payload_hash) !== t.tag) {
      if (!prep && await applied()) return duplicate();
      await say(`That application changed after I showed it, so nothing was approved. Tap Apply on the card again to see the current one.`);
      return { toast: "Changed. Nothing approved.", status: "changed" };
    }
    if (byHandUrl(job.url) || byHandUrl(String((prep.payload as Record<string, unknown>)?.destination ?? prep.url ?? ""))) {
      await say(`I don't apply on LinkedIn, Indeed or Handshake for you, so nothing was approved. Open it and apply there yourself:\n${job.url}`);
      return { toast: "Apply there yourself.", status: "never_automated" };
    }
    if (secretFields(prep).length) { await say(`That application has a field that needs you (a password, code or similar), so nothing was approved. Finish it yourself on the employer's form:\n${prep.url}`); return { toast: "Needs you.", status: "needs_you" }; }
    const screened = await screenedOut(userId, job, deps);
    if (screened) { await say(`Nothing was approved: ${screened}`); return { toast: "Not approved.", status: "screened" }; }
    if (deps.cards.confirm) {
      // One transaction: the card opened and answered together, bound to exactly this hash, so no other approval running at the
      // same moment can close it in between (two at once each approve their own; the same posting twice goes once).
      let got: { card?: { id: string }; results: CardResult[] };
      try { got = await deps.cards.confirm(userId, [prep.id], [prep.payload_hash]); } catch (e) {
        if (await applied()) return duplicate();
        if (/card_changed|invalid card/.test(String((e as Error)?.message ?? e))) {
          await say(`That application changed after I showed it, so nothing was approved. Tap Apply on the card again.`);
          return { toast: "Changed. Nothing approved.", status: "changed" };
        }
        await say("I couldn't open the approval just now, so nothing was approved. Tap Confirm again in a minute.");
        return { toast: "Nothing approved.", status: "failed" };
      }
      const results = Array.isArray(got?.results) ? got.results : [];
      await recordEvents(deps.events ?? null, results.map((r) => ({
        user_id: userId, at: deps.now(), kind: r.result === "queued" ? "application_approved" : "status_change", subject: r.company,
        detail: { card: got.card?.id ?? null, n: r.n, result: r.result, via: "telegram button" }, source: "card",
      })));
      if (results.length === 1 && results[0].result === "queued") { await say(QUEUED_REPLY(job.company, job.title)); return { toast: "Confirmed, queued.", status: "confirmed" }; }
      if (results.length && results.every((r) => r.result === "duplicate")) return duplicate();
      await say(answerText(results, {}));
      return { toast: "Nothing approved.", status: "answered" };
    }
    let card;
    try { card = await deps.cards.open(userId, [prep.id]); } catch {
      if (await applied()) return duplicate();
      await say("I couldn't open the approval just now, so nothing was approved. Tap Confirm again in a minute."); return { toast: "Nothing approved.", status: "failed" };
    }
    if (card.items?.length !== 1 || card.items[0].prepared_id !== prep.id || card.items[0].payload_hash !== prep.payload_hash) {
      await say(`That application changed after I showed it, so nothing was approved. Tap Apply on the card again.`);
      return { toast: "Changed. Nothing approved.", status: "changed" };
    }
    const digest = await cardDigest(card);
    const r = await tapCard({ userId, data: `tca:${card.id}:${digest}`, now: deps.now(), store: deps.tap, events: deps.events ?? null });
    const queued = r.status === "answered" && /^Approved/.test(r.toast);
    await say(queued ? QUEUED_REPLY(job.company, job.title) : r.reply);
    return { toast: queued ? "Confirmed, queued." : "Nothing approved.", status: queued ? "confirmed" : r.status };
  }
  return { toast: "That button no longer works.", status: "unknown" };
}

// The person's CONFIRMED facts for the posting screen: the same source and shape the chat's apply turn uses (agent-chat/handler-career.ts:
// CareerProfile.confirmedFacts of the account's profile + the facts the person stated), read from the account record (career_watch_kv
// "career:account"). An unreadable record throws: the screen then sees no facts, so a knock-out that needs one HOLDS the posting.
// deno-lint-ignore no-explicit-any
export function supabaseConfirmedFacts(admin: any): (userId: string) => Promise<any[]> {
  return async (userId) => {
    const r = await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", "career:account").maybeSingle();
    if (r.error) throw new Error(`read the account: ${r.error.message}`);
    const acct = r.data?.value ?? null;
    const profile = acct?.memory?.profile ?? { facts: [] };
    return chatScreenFacts(CareerProfile.confirmedFacts(profile), statedFactsBefore(acct, null));
  };
}

// ---------------------------------------------------------------- the store over Supabase
// Remembered cards and saves live in career_watch_kv (a per-person key/value the service role writes): no new table.
// deno-lint-ignore no-explicit-any
export function supabaseJobStore(admin: any): JobStore {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const put = async (userId: string, key: string, value: unknown) => { must(await admin.from("career_watch_kv").upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save"); };
  const get = async (userId: string, key: string) => (must(await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", key).maybeSingle(), "read"))?.value ?? null;
  return {
    async remember(userId, ref, job, shownAs) { await put(userId, `tg:job:${ref}`, { job, shownAs }); },
    async recall(userId, ref) { const v = await get(userId, `tg:job:${ref}`); return v?.job ? { job: v.job, shownAs: v.shownAs === "photo" ? "photo" : "text" } : null; },
    async rememberList(userId, listId, refs) { await put(userId, `tg:list:${listId}`, refs); },
    async recallList(userId, listId) { const v = await get(userId, `tg:list:${listId}`); return Array.isArray(v) ? v.map(String) : null; },
    async postings(ids) {
      if (!ids.length) return [];
      return must(await admin.from("career_postings").select("job_id,provider,company,title,location,url,description,remote,seniority_band,posted_at,first_seen_at,pay,closed_at").in("job_id", ids), "read postings") ?? [];
    },
    async save(userId, ref, job, at) {
      if (await get(userId, `tg:saved:${ref}`)) return "already";
      await put(userId, `tg:saved:${ref}`, { job, saved_at: new Date(at).toISOString() });
      return "saved";
    },
    async prepared(userId, jobId) {
      const rows = must(await admin.from("career_apply_prepared").select("id,job_id,company,url,payload,payload_hash,card_lines,state").eq("user_id", userId).eq("job_id", jobId)
        .in("state", ["ready", "shown"]).order("created_at", { ascending: false }).limit(1), "read the prepared application");
      return rows?.[0] ?? null;
    },
    async applied(userId, jobId) {
      const rows = must(await admin.from("career_apply_jobs").select("job_id").eq("user_id", userId).eq("job_id", jobId).limit(1), "read the queue");
      return !!rows?.length;
    },
    async want(userId, job, at) {
      const { wantsFrom, supabaseWantStore } = await import("./career_apply_want.ts");
      const w = wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title }], at);
      if (w.refused.length) return { result: "refused", reason: w.refused[0].reason };
      const r = await supabaseWantStore(admin).put(userId, w.ok);
      // The database's refusal codes in the person's words, never the code itself.
      if (r.refused?.length) {
        const code = String(r.refused[0].reason);
        return { result: "refused", reason: code === "daily_cap" ? "it's over the daily pace you set yourself" : code === "duplicate_job" ? "this posting is already in your applications, and each posting goes at most once" : "the apply queue refused it" };
      }
      return { result: r.already.length ? "already" : "queued" };
    },
  };
}
