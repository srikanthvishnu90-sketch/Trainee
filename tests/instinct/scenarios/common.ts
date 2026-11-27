// Instinct scenarios: what every new user does first, and the state readers the judges use.
// deno-lint-ignore-file no-explicit-any
import { check, NOT_UNDERSTOOD, notBuilt, type Scorecard } from "../judge.ts";
import type { Workers } from "../ticks.ts";
import { type Person, resumePdf, resumeText, sha256Hex, type Turn } from "../people.ts";
import type { World } from "../world.ts";

export type Run = { step: (name: string, fn: () => Promise<string | void>) => Promise<boolean>; note: (s: string) => void; block: (why: string) => void; blocked: () => string | null };

export const st = (w: World) => ({
  wanted: (u: string) => w.rows(`select posting_key, state, company from public.career_apply_wanted where user_id = '${u}' order by posting_key`),
  prepared: (u: string) => w.rows(`select id, job_id, company, state, payload_hash from public.career_apply_prepared where user_id = '${u}' order by job_id`),
  cards: (u: string) => w.rows(`select id, state, items, answer, shown_at from public.career_apply_cards where user_id = '${u}' order by shown_at`),
  jobs: (u: string) => w.rows(`select id, job_id, company, url, state, reason, confirmation_id, payload_hash, approval_hash, attempts, payload from public.career_apply_jobs where user_id = '${u}' order by job_id`),
  confirmed: (u: string) => w.rows(`select detail from public.career_events where user_id = '${u}' and kind = 'fact_confirmed'`),
  attempts: (u: string) => w.rows(`select posting_job_id, outcome, detail from public.career_apply_prepare_attempts where user_id = '${u}' order by created_at`),
  openQuestions: (u: string) => w.rows(`select key, label from public.career_apply_questions where user_id = '${u}' and state = 'open'`),
  outbox: (u: string) => w.rows(`select key, status, channel, kind, provider_id, card_id from public.career_outbox where user_id = '${u}' order by id`),
  messages: (u: string) => w.one(`select count(*) from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${u}' and m.role = 'user'`),
  shortlist: async (u: string) => JSON.parse(await w.one(`select coalesce((select state->'career'->'stores'->'discovery'->'lastShortlist' from public.agent_flow_state where user_id = '${u}' order by updated_at desc limit 1)::text, '[]')`)),
});

// The reply the person read went out through their channel: every outbox row for them delivered (texting channels).
export async function delivered(w: World, p: Person): Promise<string> {
  if (p.channel === "web") return "web: the reply is the app's response";
  const rows = await st(w).outbox(p.userId!);
  const stuck = rows.filter((r: any) => r.status !== "delivered" && r.status !== "skipped");
  check(rows.length > 0, `no outbox row for ${p.contact}: nothing was queued to the person`);
  check(!stuck.length, `${stuck.length} of ${rows.length} replies not delivered: ${JSON.stringify(stuck.slice(0, 3))}`);
  return `${rows.length} replies, each delivered through ${p.channel}`;
}

// Sign-up by the first message, the resume as a FILE (and, if Trainee can't read it, the person pastes it, as they're
// told), their own yes, then their details in a burst of messages. Each a step.
export async function onboard(w: World, run: Run, p: Person, o: { firstWords: string; resumeExtra?: string; skipResume?: boolean } = { firstWords: "hi" }) {
  await run.step("signs up with their first message", async () => {
    const t = await p.say(o.firstWords);
    check(t.status === 200, `the ${p.channel} webhook answered ${t.status}: ${JSON.stringify(t.body).slice(0, 300)}`);
    const u = await p.resolveUser();
    check(u, `no account for ${p.contact} after their first message (channel_contacts has no user): ${JSON.stringify(t.body).slice(0, 300)}`, "an account made for a new contact on this channel");
    check(t.text.trim(), `the person read nothing back (provider got no message for ${p.address})`);
    return `account ${u!.slice(0, 8)}; ${await delivered(w, p)}; read: "${t.text.slice(0, 120)}"`;
  });
  if (!(await p.resolveUser())) run.block(`no account was made for this ${p.channel} contact at sign-up`);
  if (o.skipResume) return;
  const text = resumeText(p.p, o.resumeExtra);
  const pdf = resumePdf(text), sha = await sha256Hex(pdf);
  let fromFile = false;
  await run.step("sends their resume as a PDF file and Trainee reads it", async () => {
    const t = await p.sendFile(`${p.p.first}_${p.p.last}_Resume.pdf`, "application/pdf", pdf, "here's my resume");
    check(t.status === 200, `the ${p.channel === "web" ? "app's turn" : "webhook"} answered ${t.status}: ${JSON.stringify(t.body).slice(0, 200)}`, "accept a resume file on this channel");
    const up = (await w.exists("career_resume_uploads")) ? await w.rows(`select sha256, channel from public.career_resume_uploads where user_id = '${p.userId}'`) : null;
    const shown = /Software Engineering Intern, TEST Systems Inc|Here is what I read/i.test(t.text);
    if (!up) {
      check(false, `the file was not read: no upload store in this tree, and the person was told: "${t.text.slice(0, 200)}"`, "read a resume sent as a file on this channel (store the bytes and sha256, show what was read)");
    }
    check(up!.some((r: any) => r.sha256 === sha), `no stored upload with the file's sha256 ${sha.slice(0, 12)} (uploads: ${JSON.stringify(up).slice(0, 200)}); the person read: "${t.text.slice(0, 200)}"`,
      "store the file this channel delivered, byte for byte");
    check(shown, `the file was stored but the reply did not show what was read: "${t.text.slice(0, 200)}"`);
    fromFile = true;
    return `stored ${sha.slice(0, 12)} from ${p.channel}; the reply showed its entries`;
  });
  if (!fromFile && !run.blocked()) {
    // What a person does when told the file can't be read: they paste it.
    const t = await p.say(`ok here it is pasted:\n${text}`);
    run.note(`${p.channel}: the resume file was not read, so the person pasted it (reply: "${t.text.slice(0, 120)}")`);
  }
  await run.step("confirms it in their own words; each entry is confirmed by an event naming what they sent", async () => {
    const t = await p.say("yep thats me, all correct");
    const ev = await st(w).confirmed(p.userId!);
    check(ev.length >= 1, `no fact_confirmed event after their yes; the reply: "${t.text.slice(0, 200)}"`);
    if (fromFile) check(ev.every((e: any) => e.detail?.upload?.sha256 === sha), `confirmed entries do not all name the file ${sha.slice(0, 12)}: ${JSON.stringify(ev.slice(0, 2))}`);
    return `${ev.length} entries confirmed${fromFile ? `, each naming the file ${sha.slice(0, 12)}` : " (from the pasted text)"}`;
  });
  await run.step("gives their details in a burst of messages; every message is answered and nothing is lost", async () => {
    const before = Number(await st(w).messages(p.userId!));
    const turns = await p.burst([`my name is ${p.p.first} ${p.p.last}`, `email ${p.p.email}`, `phone ${p.p.phone}`, "im a us citizen, i dont need sponsorship"]);
    const bad = turns.filter((t) => t.status !== 200);
    check(!bad.length, `${bad.length} of 4 messages refused: ${bad.map((t) => `${t.status} ${JSON.stringify(t.body).slice(0, 120)}`).join("; ")}`);
    const after = Number(await st(w).messages(p.userId!));
    check(after - before === 4, `${after - before} of 4 messages kept in the conversation`);
    const missed = turns.filter((t) => NOT_UNDERSTOOD.test(t.text));
    check(!missed.length, `4 kept, but ${missed.length} answered "I did not catch what to do with that one": ${missed.map((t) => `"${t.said}"`).join(", ")}`,
      "understand a person's name, email, phone and work status when they just say them");
    return `4 messages, 4 kept, 4 answered`;
  });
}

// Say it the messy way; when that is not understood (the catch-all, or `ok` says the state did not move), the person says
// it plainly, as people do. The step that calls this records which one worked.
export async function sayOrRetry(p: Person, run: Run, messy: string, plain: string, ok: (t: Turn) => Promise<boolean>): Promise<{ t: Turn; retried: boolean }> {
  const t = await p.say(messy);
  if (!NOT_UNDERSTOOD.test(t.text) && await ok(t)) return { t, retried: false };
  run.note(`${p.channel}: "${messy}" was not understood ("${t.text.split("\n")[0].slice(0, 100)}"); the person said "${plain}"`);
  return { t: await p.say(plain), retried: true };
}

// Prepare, answer what it asks, prepare again: until nothing new is asked or `rounds` is reached.
export async function prepareAll(w: World, ws: Workers, p: Person, rounds = 4): Promise<{ outcomes: any[]; asked: string[] }> {
  const outcomes: any[] = [], asked: string[] = [];
  for (let i = 0; i < rounds; i++) {
    outcomes.push(...(await ws.prepare()));
    const before = (await st(w).openQuestions(p.userId!)).length;
    if (!before) break;
    asked.push(...(await answerQuestions(w, p)));
    if ((await st(w).openQuestions(p.userId!)).length === before) break;
  }
  return { outcomes, asked };
}

// The questions a preparation left open, answered the way a person answers them: "what do you need from me", then each
// number with their answer in one message.
export async function answerQuestions(w: World, p: Person, rounds = 3): Promise<string[]> {
  const log: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const open = await st(w).openQuestions(p.userId!);
    if (!open.length) break;
    const t = await p.say("what do you need from me?");
    const lines = t.text.split("\n").map((l) => /^\s*(\d+)\.\s+(.*)$/.exec(l)).filter(Boolean) as RegExpExecArray[];
    const answers: string[] = [];
    for (const m of lines) {
      const v = valueFor(p, m[2]);
      if (v) answers.push(`${m[1]} ${v}`);
    }
    log.push(`asked ${lines.length}, answered ${answers.length}`);
    if (!answers.length) break;
    await p.say(answers.join("\n"));
  }
  return log;
}
function valueFor(p: Person, label: string): string | null {
  const l = label.toLowerCase();
  if (/first name/.test(l)) return p.p.first;
  if (/last name|surname|family name/.test(l)) return p.p.last;
  if (/full name|^name\b|your name/.test(l)) return `${p.p.first} ${p.p.last}`;
  if (/e-?mail/.test(l)) return p.p.email;
  if (/phone|mobile/.test(l)) return p.p.phone;
  if (/sponsor/.test(l)) return "no";
  if (/authori[sz]ed|authori[sz]ation|eligible to work/.test(l)) return "yes";
  if (/start date|available to start/.test(l)) return "May 2026";
  if (/linkedin/.test(l)) return "no";
  return null;
}

export async function requireTable(w: World, rel: string, needs: string) {
  if (!(await w.exists(rel))) notBuilt(`no table public.${rel} in this tree`, needs);
}
export const lastTurn = (p: Person): Turn | undefined => p.turns.at(-1);

// One scenario's harness error is recorded on its own card (a FAIL step naming it) and never stops the other scenarios.
export async function guarded(card: Scorecard, feature: string, what: string, ch: string, f: () => Promise<void>) {
  try { await f(); } catch (e) {
    const c = card.cards.at(-1);
    const target = c && c.feature === feature && c.channel === ch ? c : card.scenario(feature, what, ch).card;
    const msg = e instanceof Error ? e.message : String(e);
    target.steps.push({ name: "scenario finished", status: "FAIL", evidence: `the scenario stopped: ${msg}`, ms: 0 });
    console.log(`    FAIL scenario stopped: ${msg}`);
  }
}
