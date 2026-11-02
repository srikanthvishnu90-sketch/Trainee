// WHOLE JOURNEYS, ROUND 2: the seeded journeys and their checks (the world is journeys-r2-world.ts). A journey is one person's
// days, 20-60 steps drawn from a seed: sign-up and the resume confirmed; searches; applying from the chat's card, from
// Telegram's Apply and Confirm, by name and by "apply to these"; their computer preparing; outreach drafted, shown, approved
// and sent from their Gmail; corrections of confirmed facts; pause and resume; STOP and START on Telegram; switching between
// the web and Telegram; disconnecting Gmail; cancelling their plan; forget everything; and the account deleted at a random
// point. Several people's journeys run interleaved in one database.
//
// The invariants are checked after EVERY step, against the database and what every channel received:
//   I1 approval   every application row is an exact payload the person saw and approved (the card's item, the Confirm they
//                 tapped), approved under the hash it showed; every approved, queued or sent email is a draft they saw and
//                 approved, under its hash; every email Gmail accepted is one of those, with exactly that text
//   I2 quiet      nothing goes out after STOP, pause, deletion or a disconnect except what the rules allow: no email while
//                 the account is paused, stopped or gone (career_user_quiet), none from a disconnected Gmail; nothing to a
//                 stopped Telegram chat that the person did not ask for; nothing at all to a deleted account
//   I3 facts      no fact used that is not confirmed: nothing about them before the resume is confirmed and after it is
//                 forgotten; a corrected value (the GPA, the graduation year) never used again, in a reply or a payload
//   I4 once       no duplicate application (one row per posting) and no duplicate email (one Gmail send per draft)
//   I5 reasons    every refusal and every ending has a plain reason (a reply that says something, never empty or a crash)
//   I6 others     no other person's data in any reply (their name, school, email, contacts)
//   I7 budget     no model call but the scripted drafter's, only on a drafting turn, at most one per draft
//   I8 truth      the database agrees with what the person was told ("N approved" is N rows, "sent" only if Gmail took it,
//                 "paused" only if paused, "Done" only if Stripe says so, "disconnected" only if the grant is gone)
// A failure names the journey's seed and index and the steps so far, so it can be replayed alone (JR2_ONLY=<index>).
// deno-lint-ignore-file no-explicit-any
import { type Person, POSTINGS, connectionsCsv, emailOf, resumeOf, type World, lit as q } from "./journeys-r2-world.ts";

// The words of a page (the jobs page's HTML), for the checks a reply gets.
export const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}
export type R = ReturnType<typeof rng>;

// ------------------------------------------------------------------------------------------------ the steps
export const ACTIONS = ["resume", "confirm", "recall", "correct_gpa", "correct_grad", "search", "apply_these", "apply_one", "prepare", "card", "answer", "tg_apply",
  "cancel_app", "status", "contacts", "draft", "drafts_answer", "connect_gmail", "disconnect_gmail", "send_day", "pause", "resume_work", "tg_stop", "tg_start",
  "billing_cancel", "forget", "delete", "secret", "never", "ambiguous", "file_apply", "stale_tap"] as const;
export type Action = typeof ACTIONS[number];
export interface Step { a: Action; tg: boolean; v: number }
// Episodes: what a person sets out to do, a few steps each, drawn by weight; anything can interrupt (a single step drawn
// from the rest), and the channel switches between the web and Telegram as people do.
type Ep = (Action | [Action, number])[]; // [action, probability it happens]
const EPISODES: [number, Ep][] = [
  [10, ["search", ["ambiguous", 0.2], "apply_these", "prepare", "card", ["ambiguous", 0.25], "answer", ["card", 0.3], ["answer", 0.3]]],
  [6, ["apply_one", ["apply_one", 0.5], "prepare", "card", "answer"]],
  [8, ["tg_apply", "prepare", "tg_apply", ["tg_apply", 0.4]]],
  [6, ["file_apply", "prepare", "file_apply", ["file_apply", 0.4]]],
  [8, [["contacts", 0.6], ["connect_gmail", 0.5], "draft", ["ambiguous", 0.25], "drafts_answer", ["connect_gmail", 0.4], ["drafts_answer", 0.5], "send_day", ["status", 0.4]]],
  [5, [["correct_gpa", 0.7], ["correct_grad", 0.4], "recall", ["card", 0.5], ["answer", 0.4]]],
  [4, ["status", ["status", 0.5], ["recall", 0.5]]],
  [3, ["pause", ["status", 0.5], ["apply_one", 0.4], ["stale_tap", 0.5], ["file_apply", 0.4], ["card", 0.3], ["answer", 0.3], ["send_day", 0.6], ["drafts_answer", 0.4], ["resume_work", 0.7]]],
  // An old button tapped again: after a correction, a forget, a pause, a STOP, a newer list.
  [4, ["stale_tap", ["correct_gpa", 0.3], ["stale_tap", 0.5]]],
  [3, ["tg_stop", ["send_day", 0.7], ["tg_apply", 0.3], ["status", 0.3], ["tg_start", 0.6]]],
  [2.5, ["disconnect_gmail", ["drafts_answer", 0.5], ["send_day", 0.6], ["connect_gmail", 0.4]]],
  [2.5, ["billing_cancel", ["status", 0.3]]],
  [2.5, ["forget", ["recall", 0.7], ["stale_tap", 0.5], ["file_apply", 0.3], ["apply_one", 0.5], ["card", 0.4], ["answer", 0.3], ["send_day", 0.5]]],
  [1.5, ["delete"]],
  [5, ["send_day"]],
  [4, [["secret", 0.4], ["never", 0.5], ["ambiguous", 0.6]]],
];
const SINGLES: Action[] = ["recall", "status", "ambiguous", "card", "answer", "drafts_answer", "search", "send_day", "secret", "never", "resume_work", "tg_start"];
// One journey: sign-up first (most confirm their resume early, some late or never), then episodes; a deletion ends it.
export function journey(seed: number, i: number): { steps: Step[]; plan: boolean } {
  const r = rng(seed * 7919 + i);
  const n = r.int(20, 60);
  const steps: Step[] = [{ a: "resume", tg: r.chance(0.65), v: r.int(0, 999) }];
  if (r.chance(0.85)) steps.push({ a: "confirm", tg: steps[0].tg, v: r.int(0, 999) });
  const total = EPISODES.reduce((s, [x]) => s + x, 0);
  let tg = r.chance(0.4);
  const push = (a: Action) => {
    if (r.chance(0.15)) tg = !tg; // switching channels
    steps.push({ a, tg: a === "tg_apply" || a === "tg_stop" || a === "tg_start" ? true : tg, v: r.int(0, 999) });
  };
  outer: while (steps.length < n) {
    let x = r.next() * total, ep: Ep = EPISODES[0][1];
    for (const [wgt, e] of EPISODES) { if ((x -= wgt) <= 0) { ep = e; break; } }
    for (const item of ep) {
      const [a, p] = Array.isArray(item) ? item : [item, 1];
      if (r.next() >= p) continue;
      if (r.chance(0.08)) push(r.pick(SINGLES)); // an interruption
      push(a);
      if (a === "delete") break outer;
      if (steps.length >= n) break outer;
    }
  }
  if (!steps.some((s) => s.a === "confirm") && r.chance(0.5)) steps.splice(r.int(2, steps.length - 1), 0, { a: "confirm", tg, v: r.int(0, 999) });
  return { steps, plan: r.chance(0.5) };
}

// ------------------------------------------------------------------------------------------------ the database, read back
export interface Obs {
  jobs: { job_id: string; state: string; payload_hash: string; approval_hash: string; company: string; payload: any }[];
  wanted: string[];
  drafts: { id: string; n: number; status: string; hash: string; approved_hash: string | null; to: string; batch: string }[];
  queue: { id: string; source_id: string; approval_hash: string; state: string; to: string }[];
  account: { epoch: number; version: number; paused: boolean } | null;
  gmail: boolean; exists: boolean; opted: boolean; quiet: boolean; on_file: boolean;
  facts: string; // the profile facts on the newest thread, as text
}
export async function observe(w: World, p: Person): Promise<Obs> {
  const u = q(p.uid);
  const o = JSON.parse(await w.sql(`select json_build_object(
    'jobs', coalesce((select json_agg(json_build_object('job_id', job_id, 'state', state, 'payload_hash', payload_hash, 'approval_hash', approval_hash, 'company', company, 'payload', payload) order by created_at) from public.career_apply_jobs where user_id = ${u}), '[]'),
    'wanted', coalesce((select json_agg(posting_key order by posting_key) from public.career_apply_wanted where user_id = ${u}), '[]'),
    'drafts', coalesce((select json_agg(json_build_object('id', id, 'n', n, 'status', status, 'hash', hash, 'approved_hash', approved_hash, 'to', recipient_email, 'batch', batch_id) order by created_at, n) from public.career_outreach_drafts where user_id = ${u}), '[]'),
    'queue', coalesce((select json_agg(json_build_object('id', id, 'source_id', source_id, 'approval_hash', approval_hash, 'state', state, 'to', recipient_email) order by created_at) from public.career_send_queue where user_id = ${u}), '[]'),
    'account', (select json_build_object('epoch', coalesce((value->>'epoch')::int, 0), 'version', coalesce((value->>'version')::int, 0), 'paused', coalesce((value->>'paused')::boolean, false)) from public.career_watch_kv where user_id = ${u} and key = 'career:account'),
    'gmail', exists (select 1 from public.user_oauth_connections where user_id = ${u} and provider = 'google_career'),
    'exists', exists (select 1 from auth.users where id = ${u}),
    'opted', exists (select 1 from public.channel_contacts where user_id = ${u} and opted_out),
    'quiet', public.career_user_quiet(${u}),
    'on_file', coalesce(public.career_resume_on_file(${u}), false),
    'facts', coalesce((select (s.state->'career'->'stores'->'profile'->'facts')::text from public.agent_flow_state s where s.user_id = ${u} order by s.updated_at desc limit 1), ''))`));
  return o as Obs;
}

// ------------------------------------------------------------------------------------------------ a journey's run
export interface Finding { journey: number; seed: number; step: number; action: string; inv: string; why: string; trail: string[] }
export interface RunStats { journeys: number; steps: number; turns: number; findings: Finding[]; byAction: Record<string, number>; deleted: number; confirmed: number; applied: number; emailed: number; approvedApps: number; approvedEmails: number }

const AMBIGUOUS = ["maybe", "later", "wait", "hmm", "not sure", "ok?", "send them?", "which one pays the most?", "what's next?", "thanks"];
const YES = ["yes", "yes please", "yep", "go ahead", "approve them"];
const TALK = ["what can you do?", "how does this work?", "good morning", "I'm nervous about interviews", "thanks!"];

export class Runner {
  stats: RunStats = { journeys: 0, steps: 0, turns: 0, findings: [], byAction: {}, deleted: 0, confirmed: 0, applied: 0, emailed: 0, approvedApps: 0, approvedEmails: 0 };
  // Steps run concurrently (one person's in order); a day passing (the workers) runs alone.
  private readers = 0;
  private writer: Promise<void> | null = null;
  private wake: (() => void)[] = [];
  private async shared<T>(f: () => Promise<T>): Promise<T> {
    while (this.writer) await this.writer;
    this.readers++;
    try { return await f(); } finally { this.readers--; if (!this.readers) this.wake.splice(0).forEach((x) => x()); }
  }
  private async alone<T>(f: () => Promise<T>): Promise<T> {
    while (this.writer) await this.writer;
    let done!: () => void;
    this.writer = new Promise<void>((r) => (done = r));
    try {
      while (this.readers) await new Promise<void>((r) => this.wake.push(r));
      return await f();
    } finally { const d = done; this.writer = null; d(); }
  }
  // Gmail sends already accounted for, and Telegram messages per chat.
  private gmailSeen = 0;
  constructor(public w: World, public seed: number) {}

  private fail(p: Person, j: number, step: number, action: string, inv: string, why: string) {
    this.stats.findings.push({ journey: j, seed: this.seed, step, action, inv, why: why.slice(0, 600), trail: p.log.slice(-8) });
  }

  // One step of one person's journey: act, then every invariant.
  async step(p: Person, j: number, k: number, s: Step, plan: boolean) {
    const w = this.w;
    this.stats.steps++;
    this.stats.byAction[s.a] = (this.stats.byAction[s.a] ?? 0) + 1;
    const before = await observe(w, p);
    const tgBefore = w.bot.to(p.tg).length;
    const V = s.tg ? p.seenTg : p.seen; // what is on screen in this step's thread
    const answeredCards = Number(await w.sql(`select count(*) from public.career_apply_cards where user_id = ${q(p.uid)} and state = 'answered'`));
    const modelBefore = w.modelCalls.length;
    const sentBefore = w.gmail.sent.length;
    const replies: { text: string; intent?: string | null; status?: string | null; http: number }[] = [];
    const r = rng(s.v * 31 + k);
    let personSpoke = false; // the person sent something on Telegram this step (an answer there is allowed after STOP)
    const say = async (text: string, extra: Record<string, unknown> = {}) => {
      this.stats.turns++;
      // A plain yes while this thread's last word is the card answers the card, whatever the person had in mind.
      if (V.card && /^(?:yes\b|yep\b|go ahead\b|approve them\b|send them\b)/i.test(text) && !/\?\s*$/.test(text)) approvedNow.apps.push(...V.card.items.map((it) => `${it.job_id}|${it.payload_hash}`));
      if (V.drafts && /^(?:yes\b|yep\b|go ahead\b|approve them\b|send them\b)/i.test(text) && !/\?\s*$/.test(text)) approvedNow.drafts.push(...V.drafts.map((d) => `${d.id}|${d.hash}`));
      if (s.tg && !extra.attachments) {
        personSpoke = true;
        const t = await w.tg(p, text);
        const reply = t.said.join("\n");
        replies.push({ text: reply, http: t.status });
        p.log.push(`tg ${JSON.stringify(text.slice(0, 60))} -> ${reply.slice(0, 200).replace(/\n/g, " | ")}`);
        return { reply, intent: null as string | null, status: null as string | null, body: null as any, http: t.status };
      }
      const t = await w.web(p, text, extra);
      replies.push({ text: t.reply, intent: t.intent, status: t.resultStatus, http: t.status });
      p.log.push(`web ${JSON.stringify(text.slice(0, 60))} -> ${t.status} ${t.intent}/${t.resultStatus}: ${t.reply.slice(0, 200).replace(/\n/g, " | ")}`);
      return { reply: t.reply, intent: t.intent, status: t.resultStatus, body: t.body, http: t.status };
    };
    const F = (inv: string, why: string) => this.fail(p, j, k, s.a, inv, why);
    // What the person approves in this step (added to their approvals before the checks read the database).
    const approvedNow: { apps: string[]; drafts: string[] } = { apps: [], drafts: [] };
    let shownCard = false, shownDrafts = false, shownPage = false;
    const readCard = async (cardId: string) => {
      const items = await w.json(`select (i->>'n')::int as n, i->>'payload_hash' as payload_hash, pr.job_id, pr.company from public.career_apply_cards c, jsonb_array_elements(c.items) i
        join public.career_apply_prepared pr on pr.id = (i->>'prepared_id')::uuid where c.id = ${q(cardId)} and c.user_id = ${q(p.uid)} order by 1`);
      return { id: cardId, items };
    };
    const readShownDrafts = async () => await w.json(`select id, n, hash, recipient_email as "to" from public.career_outreach_drafts where user_id = ${q(p.uid)} and status = 'shown'
      and batch_id = (select batch_id from public.career_outreach_drafts where user_id = ${q(p.uid)} order by created_at desc limit 1) order by n`);
    const lastCardOnScreen = async (reply: { body: any; reply: string; intent: string | null; status: string | null }) => {
      const id = String(reply.body?.meta?.card_id ?? "");
      if (id) { V.card = await readCard(id); shownCard = true; }
      else if (s.tg && /applications? (?:is|are) ready/.test(reply.reply)) {
        const open = await w.sql(`select coalesce((select id::text from public.career_apply_cards where user_id = ${q(p.uid)} and state = 'open' order by shown_at desc limit 1), '')`);
        if (open) { V.card = await readCard(open); shownCard = true; }
      }
    };
    const draftsOnScreen = async (reply: { reply: string; intent: string | null; status: string | null }) => {
      if ((reply.intent === "career_outreach_batch" && /^(drafted|shown)/.test(String(reply.status))) || (s.tg && /\bDrafted \d+\/\d+|^\d+ outreach drafts?,/im.test(reply.reply))) {
        const ds = await readShownDrafts();
        if (ds.length) { V.drafts = ds; shownDrafts = true; }
      }
    };

    // ---------------------------------------------------------------------------------------- act
    let told: { reply: string; intent: string | null; status: string | null } | null = null;
    switch (s.a) {
      case "resume": {
        // Most send the file on Telegram (their computer prepares with that file); some paste it in the web chat.
        if (s.tg) {
          this.stats.turns++;
          const t = await w.tgResumeFile(p, resumeOf(p.spec));
          const reply = t.said.join("\n");
          replies.push({ text: reply, http: t.status });
          p.log.push(`tg resume.pdf -> ${reply.slice(0, 200).replace(/\n/g, " | ")}`);
          told = { reply, intent: null, status: null };
          break;
        }
        const t = await say(`here is my resume:\n${resumeOf(p.spec)}`);
        told = t;
        break;
      }
      case "confirm": {
        const t = await say(r.pick(["yes, that's my resume", "yes that's my resume", "yes, that's me"]));
        told = t;
        break;
      }
      case "recall": {
        const t = await say(r.pick(["what do you know about me?", "what is my GPA?", "where did I go to school?", "what's my email address?", "when do I graduate?"]));
        told = t;
        break;
      }
      case "correct_gpa": {
        const to = r.pick(["3.15", "3.45", "3.75", "3.95"].filter((g) => g !== p.gpa));
        const t = await say(r.pick([`actually my GPA is ${to}`, `my GPA is ${to}`]));
        told = t;
        break;
      }
      case "correct_grad": {
        const to = r.pick([2025, 2027, 2029].filter((y) => y !== p.grad));
        const t = await say(`actually I graduated ${to}`);
        told = t;
        break;
      }
      case "search": told = await say(r.pick(["find data analyst jobs in Chicago", "search for data analyst roles in Chicago", "find me data analyst jobs in Chicago"])); break;
      case "apply_these": told = await say(r.pick(["apply to these", "apply to all of them"])); break;
      case "apply_one": { const po = r.pick(POSTINGS); told = await say(`apply to the Data Analyst role at ${po.company}`); break; }
      case "prepare": {
        // Their computer prepares what waits in their queue (up to three).
        const keys = before.wanted.filter((k2) => !before.jobs.some((x) => x.job_id === k2)).slice(0, r.int(1, 3));
        const made = keys.length ? await w.prepare(p, keys) : 0;
        p.log.push(`computer prepared ${made}/${keys.length}`);
        break;
      }
      case "card": {
        const t = await say(r.pick(["show my applications", "show my applications", "show me my applications"]));
        await lastCardOnScreen(t);
        told = t;
        break;
      }
      case "answer": {
        const card = V.card;
        const kind = r.pick(["yes", "yes", "none", "subset", "ambiguous"] as const);
        const text = kind === "yes" ? r.pick(YES) : kind === "none" ? "none" : kind === "subset" ? (card && card.items.length >= 2 ? `${card.items[0].n} and ${card.items[card.items.length - 1].n}` : "1") : r.pick(AMBIGUOUS);
        if (card && (kind === "yes" || kind === "subset")) {
          const picked = kind === "yes" ? card.items : card.items.filter((it) => text.split(/\s+and\s+/).map(Number).includes(it.n));
          approvedNow.apps.push(...picked.map((it) => `${it.job_id}|${it.payload_hash}`));
        }
        const t = await say(text);
        told = t;
        await lastCardOnScreen(t);
        break;
      }
      case "tg_apply": {
        // A search on Telegram shows the cards; Apply on one opens its exact payload; Confirm approves exactly that.
        const cardsAt = w.bot.to(p.tg).length;
        await say("find data analyst jobs in Chicago");
        const buttons = w.bot.to(p.tg).slice(cardsAt).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((d) => /^jc[ay]:/.test(d));
        if (!buttons.length) break;
        const pick = r.pick(buttons);
        if (/^jcy:/.test(pick)) {
          // The card's own Apply is the hash-bound approval (a prepared payload): the card showed it.
          const tag = pick.split(":")[2];
          const prep = (await w.json(`select job_id, payload_hash from public.career_apply_prepared where user_id = ${q(p.uid)} and left(payload_hash, 16) = ${q(tag)}`))[0];
          if (prep) approvedNow.apps.push(`${prep.job_id}|${prep.payload_hash}`);
          const tp = await w.tap(p, pick);
          p.log.push(`tap ${pick} -> ${tp.answer} | ${tp.said.join(" | ").slice(0, 200)}`);
          replies.push({ text: [tp.answer, ...tp.said].join("\n"), http: tp.status });
          break;
        }
        const tp = await w.tap(p, pick);
        p.log.push(`tap ${pick} -> ${tp.answer} | ${tp.said.join(" | ").slice(0, 200)}`);
        replies.push({ text: [tp.answer, ...tp.said].join("\n"), http: tp.status });
        const confirm = w.bot.to(p.tg).slice(cardsAt).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((d) => /^jcy:/.test(d)).pop();
        if (!confirm) break;
        const tag = confirm.split(":")[2];
        const prep = (await w.json(`select job_id, payload_hash from public.career_apply_prepared where user_id = ${q(p.uid)} and left(payload_hash, 16) = ${q(tag)}`))[0];
        V.page = prep ? { jobId: prep.job_id, hash: prep.payload_hash, data: confirm } : null;
        shownPage = true;
        if (r.chance(0.75)) {
          if (prep) approvedNow.apps.push(`${prep.job_id}|${prep.payload_hash}`);
          const c = await w.tap(p, confirm);
          p.log.push(`tap Confirm -> ${c.answer} | ${c.said.join(" | ").slice(0, 200)}`);
          replies.push({ text: [c.answer, ...c.said].join("\n"), http: c.status });
        }
        break;
      }
      case "file_apply": {
        // The jobs page from their Telegram list (a search there first when they have none), signed in on their phone: Apply on
        // one row. A prepared row's form carries the tag of the exact payload the page shows; that is the approval.
        let pg = await w.filePage(p);
        if (!pg) {
          this.stats.turns++; personSpoke = true;
          const t = await w.tg(p, "find me data analyst jobs in Chicago");
          replies.push({ text: t.said.join("\n"), http: t.status });
          p.log.push(`tg "find me data analyst jobs in Chicago" -> ${t.said.join(" | ").slice(0, 160)}`);
          pg = await w.filePage(p);
        }
        if (!pg) { p.log.push("jobs page: no list"); break; }
        replies.push({ text: textOf(pg.html), http: pg.status });
        if (!pg.rows.length) { p.log.push(`jobs page ${pg.status}: no rows: ${textOf(pg.html).slice(0, 160)}`); break; }
        const row = r.pick(pg.rows);
        if (row.tag !== "none" && row.jobId) {
          const prep = (await w.json(`select job_id, payload_hash from public.career_apply_prepared where user_id = ${q(p.uid)} and job_id = ${q(row.jobId)} and left(payload_hash, 16) = ${q(row.tag)}`))[0];
          if (prep) approvedNow.apps.push(`${prep.job_id}|${prep.payload_hash}`);
        }
        this.stats.turns++;
        const res = await w.filePost(p, pg.sid, { action: "apply", ref: row.ref, tag: row.tag });
        const words = textOf(res.html);
        replies.push({ text: words, http: res.status });
        p.log.push(`jobs page Apply ${row.ref}/${row.tag} -> ${res.status}: ${words.slice(0, 200)}`);
        break;
      }
      case "cancel_app": {
        const target = before.jobs.find((x) => x.state === "queued") ?? null;
        const company = target?.company ?? r.pick(POSTINGS).company;
        told = await say(`cancel my application to ${company}`);
        break;
      }
      case "status": told = await say(r.pick(["where are my applications?", "where are my emails", "what's the status of my emails?", "what have you done for me?"])); break;
      case "contacts": {
        const t = await w.web(p, "here are my LinkedIn connections", { attachments: [{ name: "Connections.csv", mime: "text/csv", text: connectionsCsv(p.spec) }] });
        this.stats.turns++;
        replies.push({ text: t.reply, intent: t.intent, status: t.resultStatus, http: t.status });
        p.log.push(`web contacts -> ${t.intent}/${t.resultStatus}: ${t.reply.slice(0, 160)}`);
        told = { reply: t.reply, intent: t.intent, status: t.resultStatus };
        break;
      }
      case "draft": {
        let t = await say(r.pick(["draft intros to my contacts at Stripe", "email Priya at Ramp about the product role"]));
        if (t.status === "needs_signature" || /how (?:should|do) you (?:want to )?sign|sign (?:off|your emails)/i.test(t.reply)) t = await say(`${p.spec.first} ${p.spec.last}\n${p.spec.school} University`);
        await draftsOnScreen(t);
        told = t;
        break;
      }
      case "drafts_answer": {
        const kind = r.pick(["show_yes", "yes", "send1", "ambiguous", "show"] as const);
        if (kind === "show_yes" || kind === "show") {
          const t = await say("show my drafts");
          await draftsOnScreen(t);
          if (kind === "show") { told = t; break; }
        }
        const ds = V.drafts;
        const text = kind === "send1" ? "send 1" : kind === "ambiguous" ? r.pick(AMBIGUOUS) : r.pick(["yes", "yes, send them", "send them"]);
        if (ds && kind !== "ambiguous") approvedNow.drafts.push(...(kind === "send1" ? ds.filter((d) => d.n === 1) : ds).map((d) => `${d.id}|${d.hash}`));
        if (text === "send them?") approvedNow.drafts = [];
        told = await say(text);
        await draftsOnScreen(told);
        break;
      }
      case "connect_gmail": await w.connectGmail(p); p.log.push("connected Gmail"); break;
      case "disconnect_gmail": told = await say(r.pick(["disconnect gmail", "disconnect my gmail"])); break;
      case "send_day": {
        // A day passes: the send worker and the delivery run.
        // (the workers run on the database's own clock: a day here is the workers' runs, not a moved clock)
        await w.sendWorker();
        await w.deliverCron(1);
        p.log.push(`a day: gmail ${w.gmail.sent.length - sentBefore} sent`);
        break;
      }
      case "pause": told = await say(r.pick(["pause all career work", "stop everything"])); break;
      case "resume_work": told = await say("resume career work"); break;
      case "tg_stop": told = await say(r.pick(["STOP", "stop", "/stop"])); break;
      case "tg_start": told = await say(r.pick(["START", "start"])); break;
      case "billing_cancel": {
        let t = await say(r.pick(["cancel my subscription", "cancel my plan", "I want to cancel my Trainee subscription"]));
        if (/\?/.test(t.reply) && r.chance(0.8)) t = await say("yes");
        told = t;
        break;
      }
      case "forget": told = await say(r.pick(["forget everything", "forget my career profile", "delete my career profile"])); break;
      case "delete": {
        if (r.chance(0.3)) { const t = await say("delete my account"); told = t; }
        const page = r.chance(0.5) ? await w.filePage(p).catch(() => null) : null; // a jobs page left open on their phone
        const d = await w.deleteAccount(p);
        p.log.push(`deleted from the app: ${d.deleted} ${d.words.slice(0, 160)}`);
        replies.push({ text: d.words, http: 200 });
        if (d.deleted) { p.deleted = true; this.stats.deleted++; }
        else if (!/plan|Stripe|not/i.test(d.words)) F("I5", `the deletion did not happen and the words do not say why: ${d.words}`);
        if (d.deleted) {
          // What a deleted account's old doors do: an old button tapped, the open jobs page used, a text on Telegram.
          const old = w.bot.to(p.tg).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((x) => /^jc[ay]:/.test(x));
          if (old.length) {
            personSpoke = true;
            const tp = await w.tap(p, r.pick(old));
            p.log.push(`after deletion: tap -> ${tp.answer} | ${tp.said.join(" | ").slice(0, 160)}`);
            if (tp.said.some((x) => x.includes(p.spec.first) || x.includes(emailOf(p.spec)) || /GPA/.test(x))) F("I2", `a deleted account's old button showed their data: ${tp.said.join(" | ").slice(0, 200)}`);
          }
          if (page?.rows.length) {
            const again = await w.filePost(p, page.sid, { action: "apply", ref: page.rows[0].ref, tag: page.rows[0].tag });
            const words = textOf(again.html);
            p.log.push(`after deletion: the open jobs page's Apply -> ${again.status}: ${words.slice(0, 160)}`);
            if (again.status === 200 && /class="row"/.test(again.html)) F("I2", `a deleted account's jobs page still lists their postings: ${words.slice(0, 200)}`);
          }
          personSpoke = true;
          const t = await w.tg(p, "hi, what do you know about me?");
          p.log.push(`after deletion: tg -> ${t.said.join(" | ").slice(0, 160)}`);
          if (t.said.some((x) => x.includes(p.spec.first) || x.includes(`${p.spec.school} University`))) F("I2", `a deleted account's Telegram chat was answered with their data: ${t.said.join(" | ").slice(0, 200)}`);
        }
        break;
      }
      case "stale_tap": {
        // A button from an earlier message, tapped again now (a Confirm, an Apply).
        const old = w.bot.to(p.tg).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((x) => /^jc[ay]:/.test(x));
        if (!old.length) break;
        const pick = r.pick(old);
        if (/^jcy:/.test(pick)) {
          const tag = pick.split(":")[2];
          const prep = (await w.json(`select job_id, payload_hash from public.career_apply_prepared where user_id = ${q(p.uid)} and left(payload_hash, 16) = ${q(tag)}`))[0];
          if (prep) approvedNow.apps.push(`${prep.job_id}|${prep.payload_hash}`); // the person saw this exact payload's tag on that button
        }
        this.stats.turns++; personSpoke = true;
        const tp = await w.tap(p, pick);
        replies.push({ text: [tp.answer, ...tp.said].join("\n"), http: tp.status });
        p.log.push(`old tap ${pick} -> ${tp.answer} | ${tp.said.join(" | ").slice(0, 200)}`);
        break;
      }
      case "secret": told = await say(r.pick(["my password is Hunter2!x", "my card is 4111 1111 1111 1111"])); break;
      case "never": told = await say(r.pick(["apply to the Data Analyst job at Contoso on LinkedIn", "send a message to Maya on LinkedIn", "apply to this one https://www.linkedin.com/jobs/view/123456"])); break;
      case "ambiguous": told = await say(r.pick([...AMBIGUOUS, ...TALK])); break;
    }
    // A reply that is not the card or the drafts takes them off the screen (a bare yes later is not theirs).
    // The card's own "which ones?" answer keeps it on screen (it is still this thread's last word); anything else takes it off.
    const cardAsks = replies.length === 1 && (told?.intent === "career_apply_card" || /reply "yes" to send (?:all \d+|it) exactly as shown/i.test(replies[0].text));
    if (replies.length && !shownCard && !cardAsks) V.card = null;
    // "send 1" leaves the rest of the batch on screen ("Not sent: 2"): it is still the thread's last word.
    if (replies.length && !shownDrafts && V.drafts && replies.length === 1 && /\bNot sent: \d/.test(replies[0].text)) {
      const still = new Set((await readShownDrafts()).map((d: { id: string }) => d.id));
      V.drafts = V.drafts.filter((d) => still.has(d.id));
      if (!V.drafts.length) V.drafts = null;
    } else if (replies.length && !shownDrafts) V.drafts = null;
    if (replies.length && !shownPage && s.a !== "tg_apply") V.page = null;
    for (const x of approvedNow.apps) p.approvedApps.add(x);
    for (const x of approvedNow.drafts) p.approvedDrafts.add(x);

    // ---------------------------------------------------------------------------------------- the state the person is in
    const after = await observe(w, p);
    p.confirmed = after.on_file;
    if (s.a === "correct_gpa" && told) {
      const m = /GPA (?:is|to) (\d\.\d+)/i.exec(String(p.log.at(-1)));
      const to = /(\d\.\d{2})/.exec(p.log.at(-1)!.split("->")[0])?.[1];
      if (to && after.facts.includes(`GPA ${to}`)) { if (!p.retiredGpa.includes(p.gpa)) p.retiredGpa.push(p.gpa); p.gpa = to; }
      void m;
    }
    if (s.a === "correct_grad" && told) {
      const to = Number(/(20\d\d)/.exec(p.log.at(-1)!.split("->")[0])?.[1]);
      if (to && after.facts.includes(String(to)) && !after.facts.includes(`May ${p.grad}`)) { if (!p.retiredGrad.includes(p.grad)) p.retiredGrad.push(p.grad); p.grad = to; }
    }
    p.paused = after.account?.paused === true;
    p.tgStopped = after.opted;
    p.gmail = after.gmail;
    if (after.account && before.account && after.account.epoch > before.account.epoch) { p.erased = true; p.confirmed = false; p.retiredGpa.push(p.gpa); }

    // ---------------------------------------------------------------------------------------- the invariants
    // I1 approval: applications
    for (const jb of after.jobs) {
      if (jb.approval_hash !== jb.payload_hash) F("I1", `${jb.company}: approved under ${jb.approval_hash?.slice(0, 12)}, the payload is ${jb.payload_hash?.slice(0, 12)}`);
      if (!before.jobs.some((x) => x.job_id === jb.job_id && x.approval_hash === jb.approval_hash) && !p.approvedApps.has(`${jb.job_id}|${jb.approval_hash}`)) {
        F("I1", `${jb.company} (${jb.state}) approved without the person approving that exact payload; step said ${JSON.stringify(p.log.at(-1)?.slice(0, 120))}`);
      }
    }
    // I1 approval: emails
    for (const d of after.drafts) {
      if (/^(approved|queued|sent)$/.test(d.status)) {
        if (d.approved_hash !== d.hash) F("I1", `draft to ${d.to} ${d.status} under ${String(d.approved_hash).slice(0, 12)}, its text is ${d.hash.slice(0, 12)}`);
        const was = before.drafts.find((x) => x.id === d.id);
        if (!(was && /^(approved|queued|sent)$/.test(was.status)) && !p.approvedDrafts.has(`${d.id}|${d.approved_hash}`)) F("I1", `draft to ${d.to} became ${d.status} without the person approving it; step said ${JSON.stringify(p.log.at(-1)?.slice(0, 120))}`);
      }
    }
    for (const qr of after.queue) {
      const d = after.drafts.find((x) => x.id === qr.source_id);
      if (!d || !p.approvedDrafts.has(`${d.id}|${qr.approval_hash}`)) {
        if (!before.queue.some((x) => x.id === qr.id)) F("I1", `an email to ${qr.to} was queued that the person did not approve (${qr.approval_hash.slice(0, 12)})`);
      }
    }
    // Gmail: every send is one of this person's queue rows, approved; once per draft; none while quiet or disconnected.
    const mine = w.gmail.sent.slice(sentBefore).filter((m) => m.account === p.uid);
    for (const m of mine) {
      const qr = after.queue.find((x) => x.to === m.to);
      if (!qr) F("I1", `Gmail sent ${m.to} with no approved queue row of theirs`);
      if (before.quiet) F("I2", `Gmail sent ${m.to} while the account was paused, stopped or gone`);
      if (!before.gmail) F("I2", `Gmail sent ${m.to} after Gmail was disconnected`);
    }
    // A pause holds: the chat says "Career work is paused, so I didn't start anything"; nothing is approved meanwhile, on any door.
    if (before.account?.paused && after.account?.paused) {
      const nj = after.jobs.filter((x) => !before.jobs.some((y) => y.job_id === x.job_id && y.approval_hash === x.approval_hash));
      if (nj.length) F("I2", `${nj.length} application(s) approved while career work is paused (${nj.map((x) => x.company).join(", ")}): ${(p.log.at(-1) ?? "").slice(0, 200)}`);
      if (after.wanted.length > before.wanted.length) F("I2", `${after.wanted.length - before.wanted.length} posting(s) queued while career work is paused: ${(p.log.at(-1) ?? "").slice(0, 200)}`);
      const nd = after.drafts.filter((d) => /^(approved|queued|sent)$/.test(d.status) && !before.drafts.some((x) => x.id === d.id && /^(approved|queued|sent)$/.test(x.status)));
      if (nd.length) F("I2", `${nd.length} email(s) approved while career work is paused`);
    }
    // I4 once
    const ids = after.jobs.map((x) => x.job_id);
    if (new Set(ids).size !== ids.length) F("I4", `two application rows for one posting: ${ids.join(",")}`);
    const urls = after.jobs.map((x) => x.payload?.url).filter(Boolean);
    if (new Set(urls).size !== urls.length) F("I4", `two applications to one link`);
    const allMine = w.gmail.sent.filter((m) => m.account === p.uid);
    const tos = allMine.map((m) => m.to);
    if (new Set(tos).size !== tos.length) F("I4", `one address emailed twice: ${tos.join(",")}`);
    // I2 quiet: Telegram, nothing the person did not ask for while stopped; nothing at all once deleted.
    const tgNow = w.bot.to(p.tg).length - tgBefore;
    if (tgNow && before.opted && !personSpoke) F("I2", `${tgNow} Telegram message(s) after STOP that the person did not ask for: ${w.bot.to(p.tg).slice(tgBefore).map((m) => m.text.slice(0, 80)).join(" | ")}`);
    if (p.deleted && s.a !== "delete") {
      if (after.exists) F("I8", "the account was said deleted and still exists");
      if (after.jobs.length || after.queue.length || after.drafts.length) F("I2", "rows of a deleted account remain");
      if (tgNow && !personSpoke) F("I2", "a Telegram message to a deleted account");
    }
    // I3 facts: nothing about them before a confirmed resume; a retired value never used.
    for (const rp of replies) {
      const t = rp.text.split("\n").filter((l) => !/^\s*Was:/.test(l)).join("\n");
      for (const g of p.retiredGpa) if (g !== p.gpa && new RegExp(`GPA[^\\n]{0,12}\\b${g.replace(".", "\\.")}\\b|\\b${g.replace(".", "\\.")}\\s*GPA`).test(t) && !/pasted|resume:/.test(p.log.at(-1) ?? "")) F("I3", `a corrected GPA (${g}, now ${p.gpa}) was used: ${t.slice(0, 300)}`);
      for (const y of p.retiredGrad) if (y !== p.grad && new RegExp(`graduat[^\\n]{0,30}\\b${y}\\b`, "i").test(t)) F("I3", `a corrected graduation year (${y}, now ${p.grad}) was used: ${t.slice(0, 300)}`);
      // I6 others
      for (const o of w.people) {
        if (o === p) continue;
        for (const mark of [`${o.spec.first} ${o.spec.last}`, emailOf(o.spec), `${o.spec.school} University`, `.${o.spec.last.toLowerCase()}${o.spec.i}@`]) {
          if (t.includes(mark)) F("I6", `another person's data (${mark}) in a reply: ${t.slice(0, 200)}`);
        }
      }
      // I5 reasons
      if (rp.http >= 500) F("I5", `HTTP ${rp.http}: ${t.slice(0, 200)}`);
      if (!t.trim() && !(s.tg && (p.tgStopped || before.opted))) F("I5", `an empty reply`);
      if (/\b(?:undefined|null|NaN|\[object Object\])\b/.test(t.replace(/null and void/g, ""))) F("I5", `a broken reply: ${t.slice(0, 200)}`);
      // A reason that is not true: "That card was already answered" when no card of theirs was ever answered.
      if (/That card was already answered/.test(t) && answeredCards === 0) F("I5", `told a card was already answered; no card of theirs was ever answered: ${t.slice(0, 160)}`);
    }
    for (const jb of after.jobs) {
      const fields = JSON.stringify(jb.payload?.fields ?? []);
      if (!before.jobs.some((x) => x.job_id === jb.job_id)) for (const g of p.retiredGpa) if (g !== p.gpa && fields.includes(`"value":"${g}"`)) F("I3", `an application approved with a corrected GPA (${g})`);
    }
    // I7 budget: the scripted drafter only on drafting turns, at most one call per draft.
    const made = w.modelCalls.slice(modelBefore).filter((c) => c.user === p.uid);
    if (w.modelCalls.slice(modelBefore).some((c) => !c.user)) F("I7", "a model call no person's turn made");
    const drafter = made.filter((c) => !c.brain).length, brain = made.filter((c) => c.brain).length;
    if (drafter && !/^(draft|drafts_answer|ambiguous|answer)$/.test(s.a)) F("I7", `${drafter} drafter call(s) on a ${s.a} step`);
    const newDrafts = after.drafts.length - before.drafts.length;
    if (drafter > Math.max(newDrafts, 0) + 1) F("I7", `${drafter} drafter calls for ${newDrafts} new draft(s)`);
    if (brain > 8 * Math.max(1, replies.length)) F("I7", `${brain} brain calls in one step`);
    if (made.length && (before.quiet && before.account?.paused)) F("I7", `${made.length} model call(s) while the account is paused`);
    // I8 truth: what the reply said agrees with the database.
    const said = told?.reply ?? replies.map((x) => x.text).join("\n");
    const newJobs = after.jobs.filter((x) => !before.jobs.some((y) => y.job_id === x.job_id)).length;
    const m1 = /^(\d+) approved exactly as shown/m.exec(said);
    if (m1 && Number(m1[1]) !== newJobs) F("I8", `said ${m1[1]} approved, ${newJobs} new application row(s): ${said.slice(0, 200)}`);
    if (/Nothing was approved/i.test(said) && newJobs) F("I8", `said nothing was approved, ${newJobs} new application row(s)`);
    const approvedDraftsNow = after.drafts.filter((d) => /^(approved|queued|sent)$/.test(d.status) && !before.drafts.some((x) => x.id === d.id && /^(approved|queued|sent)$/.test(x.status))).length;
    const m2 = /Approved (\d+), exactly as shown/.exec(said);
    if (m2 && Number(m2[1]) !== approvedDraftsNow) F("I8", `said ${m2[1]} emails approved, ${approvedDraftsNow} changed: ${said.slice(0, 200)}`);
    if (!m2 && approvedDraftsNow && !/approv/i.test(said)) F("I8", `${approvedDraftsNow} draft(s) approved and the reply does not say so: ${said.slice(0, 200)}`);
    if (newJobs && !m1 && !/approv|confirm|queued|sent|submitted|applying/i.test(said)) F("I8", `${newJobs} application(s) approved and the reply does not say so: ${said.slice(0, 200)}`);
    if (s.a === "pause" && /Career work is paused/.test(said) && !after.account?.paused) F("I8", "said paused; the account is not paused");
    // Emails: "they go from your Gmail" only when Gmail is connected and they are on the send rail; "until your Gmail is
    // connected" only when it is not.
    if (/until your Gmail is connected/.test(said) && before.gmail && after.gmail) F("I8", `told Gmail is not connected; it is: ${said.slice(0, 160)}`);
    if (/They go from your Gmail/.test(said)) {
      if (!after.gmail) F("I8", `told they go from your Gmail; no Gmail is connected: ${said.slice(0, 160)}`);
      const fresh = after.drafts.filter((d) => /^(approved|queued|sent)$/.test(d.status) && !before.drafts.some((x) => x.id === d.id && /^(approved|queued|sent)$/.test(x.status)));
      const railed = fresh.filter((d) => after.queue.some((qr) => qr.source_id === d.id));
      if (fresh.length && railed.length < fresh.length && !/Won't be sent/.test(said)) F("I8", `told ${fresh.length} go from your Gmail; ${railed.length} are on the send rail: ${said.slice(0, 160)}`);
    }
    if (s.a === "resume_work" && /pause is lifted/.test(said) && after.account?.paused) F("I8", "said the pause is lifted; the account is still paused");
    if (s.a === "disconnect_gmail" && before.gmail && after.gmail) F("I8", `asked to disconnect Gmail; the grant is still there: ${said.slice(0, 200)}`);
    if (s.a === "disconnect_gmail" && before.gmail && !after.gmail && w.revokes.length === 0) F("I8", "Gmail disconnected without a revoke at Google");
    if (s.a === "billing_cancel" && plan) {
      const sub = w.stripe.subs.get(`sub_jr2_${p.spec.i}`);
      if (/\bDone\b|is cancelled|is canceled|won't renew|will not renew/i.test(said) && !(sub?.cancel_at_period_end || sub?.status === "canceled")) F("I8", `said the plan is cancelled; Stripe says ${JSON.stringify(sub && { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end })}: ${said.slice(0, 200)}`);
    }
    if (/\b(\d+) emails? sent\b/.test(said)) {
      const n = Number(/\b(\d+) emails? sent\b/.exec(said)![1]);
      const sent = after.queue.filter((x) => x.state === "sent").length;
      if (n !== sent && !/\b0 emails? sent\b/.test(said)) F("I8", `said ${n} email(s) sent; ${sent} sent on record: ${said.slice(0, 200)}`);
    }
    const claims = said.split(/(?<=[.!?\n])\s+/).filter((x) => /\bsubmitted\b/i.test(x) && !/\b(?:not|nothing|never|no|until|before|once|when|after|if|unless|only|isn't|hasn't|won't|wasn't|aren't|haven't)\b/i.test(x));
    if (claims.length && after.jobs.every((x) => x.state !== "submitted")) F("I8", `the reply says submitted; nothing is submitted: ${claims[0].slice(0, 200)}`);
    // Before any resume is confirmed (or after it is forgotten): an application is refused, never queued.
    if (!after.on_file && after.wanted.length > before.wanted.length) F("I3", `a posting queued for applying without a confirmed resume on file: ${said.slice(0, 200)}`);
    if (after.wanted.length > before.wanted.length) this.stats.applied += after.wanted.length - before.wanted.length;
    this.stats.approvedApps += newJobs;
    this.stats.approvedEmails += approvedDraftsNow;
    this.stats.emailed += mine.length;
    // Rows of the account after forget everything: the profile is gone.
    if (p.erased && s.a === "forget") {
      if (after.facts && after.facts.includes(`${p.spec.school} University`)) F("I3", "forget everything left the resume's facts in the profile");
    }
    // Forget everything: said only when done; what waited to be sent stops with it.
    if (s.a === "forget") {
      const erasedNow = !!(after.account && before.account && after.account.epoch > before.account.epoch);
      if (/I removed your saved career profile|forgot|erased|deleted your/i.test(said) && !erasedNow && !/nothing to|not (?:removed|erased|deleted)|didn't|did not|can't|cannot/i.test(said)) F("I8", `told it was forgotten; nothing was erased: ${said.slice(0, 200)}`);
      if (erasedNow) {
        if (after.jobs.some((x) => x.state === "queued")) F("I2", `forget everything left ${after.jobs.filter((x) => x.state === "queued").length} approved application(s) waiting to be sent`);
        if (after.on_file) F("I3", "forget everything left a resume on file to apply with");
      }
    }
    if (/\b(?:your account (?:is|was|has been) deleted|I deleted your account)\b/i.test(said) && after.exists) F("I8", `told the account is deleted; it exists: ${said.slice(0, 200)}`);
    // After an erase, nothing about them is recalled until they confirm a resume again.
    if (p.erased && !after.on_file && s.a === "recall" && (said.includes(`${p.spec.school} University`) || said.includes(emailOf(p.spec)))) F("I3", `recalled a forgotten fact: ${said.slice(0, 200)}`);
  }

  // Several people's journeys, interleaved in one database.
  async run(group: { j: number; p: Person; steps: Step[]; plan: boolean }[], r: R) {
    const w = this.w;
    for (const g of group) {
      this.stats.journeys++;
      if (g.plan) {
        const end = Math.floor(Date.now() / 1000) + 20 * 86400, sid = `sub_jr2_${g.p.spec.i}`, cus = `cus_jr2_${g.p.spec.i}`;
        w.stripe.subs.set(sid, { id: sid, customer: cus, status: "active", cancel_at_period_end: false, cancel_at: null, current_period_start: end - 30 * 86400, current_period_end: end, created: end - 60 * 86400,
          metadata: { supabase_user_id: g.p.uid }, price: { unit_amount: 1500, currency: "usd", interval: "month" }, quantity: 1 });
        w.stripe.customers.set(cus, { id: cus, metadata: { supabase_user_id: g.p.uid } });
        await w.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end)
          values (${q(g.p.uid)}, 'active', 'monthly', 1500, to_timestamp(${end - 30 * 86400}), to_timestamp(${end}), ${q(cus)}, ${q(sid)}, false)`);
      }
    }
    // Each person's steps in order; the people at once, started in a seeded order.
    const order = group.slice().sort(() => 0).map((g) => ({ g, delay: r.int(0, 3) }));
    await Promise.all(order.map(async ({ g, delay }) => {
      for (let i = 0; i < delay; i++) await Promise.resolve();
      for (let k = 0; k < g.steps.length; k++) {
        if (g.p.deleted) break;
        const s = g.steps[k];
        const run = () => w.as(g.p, () => this.step(g.p, g.j, k, s, g.plan));
        try {
          await (s.a === "send_day" ? this.alone(run) : this.shared(run));
        } catch (e) {
          this.fail(g.p, g.j, k, s.a, "I5", `the step threw: ${(e as Error)?.stack?.slice(0, 400) ?? e}`);
        }
      }
    }));
    // After everyone: a last day passes (workers run) and the quiet ones stay quiet.
    const sentBefore = w.gmail.sent.length;
    const tgBefore = new Map(group.map((g) => [g.p.uid, w.bot.to(g.p.tg).length]));
    const quiet = new Map<string, boolean>();
    for (const g of group) quiet.set(g.p.uid, (await observe(w, g.p)).quiet);
    // the workers run again
    await w.sendWorker();
    await w.deliverCron(2);
    for (const g of group) {
      const sent = w.gmail.sent.slice(sentBefore).filter((m) => m.account === g.p.uid);
      if (sent.length && quiet.get(g.p.uid)) this.fail(g.p, g.j, g.steps.length, "end", "I2", `${sent.length} email(s) went from a paused, stopped or deleted account`);
      const tg = w.bot.to(g.p.tg).length - tgBefore.get(g.p.uid)!;
      if (tg && (g.p.deleted || g.p.tgStopped)) this.fail(g.p, g.j, g.steps.length, "end", "I2", `${tg} Telegram message(s) to a ${g.p.deleted ? "deleted" : "stopped"} account on a day it said nothing`);
      for (const m of sent) {
        const o = await observe(w, g.p);
        if (!o.queue.some((x) => x.to === m.to)) this.fail(g.p, g.j, g.steps.length, "end", "I1", `Gmail sent ${m.to} with no approved queue row`);
      }
    }
    if (Deno.env.get("JR2_TRACE")) for (const g of group) console.log(`--- journey ${g.j} (${g.p.spec.first} ${g.p.spec.last}${g.plan ? ", a plan" : ""})\n  ${g.p.log.join("\n  ")}`);
    if (w.outbound.length) this.stats.findings.push({ journey: -1, seed: this.seed, step: 0, action: "network", inv: "I7", why: `requests left the machine: ${w.outbound.slice(0, 5).join(", ")}`, trail: [] });
  }
}
