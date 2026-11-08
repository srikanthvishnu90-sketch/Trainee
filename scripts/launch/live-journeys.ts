// R3 of the test ladder (docs/architect/TEST-STRATEGY-2026-11-01.md): LIVE synthetic journeys against production, after every
// deploy, with no human. It posts Telegram-shaped webhook updates, signed with the bot's webhook secret header, for ONE
// dedicated synthetic chat to the deployed trainee-telegram function, then reads the database back through narrow queries
// scoped to that synthetic account, and finally erases everything the run made. A FAIL rolls the deploy back (D-034 S6,
// .github/workflows/deploy-production.yml).
//
//   deno run -A scripts/launch/live-journeys.ts --live     production (inputs below; exit 2 = NOT RUN when one is missing)
//   deno run -A scripts/launch/live-journeys.ts --dry      the same journeys over HTTP against a local trainee-telegram on a
//                                                          throwaway Postgres with every migration, a fake Bot API and the
//                                                          scripted model (scripts/launch/live-journeys-dry.ts). $0, no network.
// Exit: 0 PASS, 1 FAIL (rolls back), 2 NOT RUN (an input is missing: never a pass, never a rollback), 3 PASS but the clean-up
// left rows of the synthetic account (a warning; the next run's preflight erases them).
//
// Live inputs (GitHub environment `production` secrets; names only, no value is ever printed):
//   LIVE_JOURNEY_ENABLED=true                the owner's switch, set once the chat below may sign up; otherwise NOT RUN
//   SUPABASE_PROJECT_REF (or SUPABASE_URL)   the project; the webhook is <url>/functions/v1/trainee-telegram
//   TELEGRAM_WEBHOOK_SECRET                  the header Telegram itself sends (X-Telegram-Bot-Api-Secret-Token)
//   SUPABASE_DB_URL                          psql, for the scoped reads, the two seams and the clean-up
//   LIVE_JOURNEY_TELEGRAM_CHAT_ID (optional) a private chat the owner made for this (a second Telegram account that pressed
//                                            Start on the bot). With it every reply must be DELIVERED (Telegram answered
//                                            sendMessage 200 and gave a message id: career_outbox.provider_ids). Without it
//                                            the run uses SYNTHETIC_CHAT (an id far above any assigned Telegram id, so no
//                                            person can receive it), asserts each reply's outbox row, and prints
//                                            delivery UNVERIFIED.
//   The chat must be allowed to sign up: TRAINEE_SIGNUP=open, or "telegram:<chat id>" in TRAINEE_ALLOWED_CONTACTS.
//
// What it writes to production, all of it scoped to the synthetic account or this run, all of it erased at the end:
//   - the account the "hi" creates (the product makes it) and a marker row career_watch_kv 'synthetic:live-journey', the
//     ONLY thing that lets a later run erase that account (an unmarked account on the chat is refused, never touched);
//   - one sandbox posting (career_postings), key greenhouse:trainee-sandbox:<run>, whose link is on SANDBOX_HOST, a name
//     under the reserved .invalid TLD (RFC 2606): it can never resolve, so no step can reach an employer. Posted 30 days
//     before it is first seen, so the alert planner never treats it as news for anyone (career_fresh.ts freshWhenSeen);
//   - the preparation worker's output for that posting (career_apply_prepared), the same seam the Telegram acceptance suite
//     seeds (tests/architect/telegram-acceptance.test.ts): the worker drives a browser and is proven by R0/R4, not here.
// Never: an employer submission (the approved job stays queued: the person has no cloud opt-in and no extension), an
// email (no mailbox is connected; the draft is never approved), a LinkedIn/Indeed action, a model call beyond what the
// deployed router makes on its own (the networking writer: one short draft).
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const SANDBOX_HOST = "sandbox-employer.trainee.invalid";
// 2^52 - 1000: Telegram user ids have at most 52 significant bits and are assigned upward from small numbers (~1e10 today).
export const SYNTHETIC_CHAT = 4_503_599_627_369_496;
export const MARKER_KEY = "synthetic:live-journey";
// Hosts that are real employers' application systems: a sandbox URL on one of them is refused before anything runs.
export const EMPLOYER_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|taleo\.net|bamboohr\.com|workable\.com|linkedin\.com|indeed\.com|joinhandshake\.com)$/i;

export const STEPS = [
  "preflight-synthetic-only",
  "preflight-stale-postings-swept",
  "new-account-from-hi",
  "resume-confirm-one-record",
  "search-lists-sandbox-posting",
  "fit-confirmed-facts-only",
  "fit-question-answered",
  "approval-card-exact-payload",
  "approve-tap-queues-sandbox-job",
  "status-matches-db",
  "outreach-draft-not-sent",
  "reminder-scheduled",
  "alerts-watch-saved",
  "stop-opts-out",
  "sandbox-posting-private",
  "replies-delivered",
  "cleanup-erases-everything",
] as const;
export type StepId = (typeof STEPS)[number];
// Steps the product cannot pass yet. Each must also be a KNOWN_GAP of the Telegram acceptance suite (S4), so this list can
// only shrink with that one (tests/architect/live-journeys.test.ts). A gap still runs and prints its outcome; it never fails
// the run, because the deployed SHA being rolled back to fails it too.
export const KNOWN_GAP: readonly StepId[] = ["fit-question-answered"];

export interface Db { sql(text: string): Promise<string> }
export type Delivery = "verified" | "unverified";
export interface JourneyOpts {
  post(update: Record<string, unknown>): Promise<{ status: number; body: string }>; // one signed webhook POST
  db: Db; // raw access; the journey reaches it only through scoped()
  chat: number;
  delivery: Delivery;
  runId: string; // [a-z0-9-], names this run's sandbox posting
  resume: string; // a synthetic resume (packages/career-data/fixtures/test-resume.txt)
  log?: (line: string) => void;
  replyTimeoutMs?: number; // how long to wait for a reply's outbox row (live: the function may answer the webhook first)
  paceMs?: number; // between updates (live: Telegram's own pacing and the per-person turn limit)
  tapWaitMs?: number; // after a button tap (it has no reply row to wait for)
  whilePostingLive?: (p: { company: string; title: string; board: string }) => Promise<void>; // dry mode: another person searches
}
export interface StepResult { id: StepId; outcome: "PASS" | "FAIL" | "KNOWN_GAP still fails" | "KNOWN_GAP NOW PASSES" | "SKIPPED"; why?: string }
export interface JourneyReport { results: StepResult[]; delivery: Delivery; pass: boolean; cleanedUp: boolean; userId: string | null; updates: number }

const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const WRITE = /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|call|do)\b/i;

// Every statement the journey sends names the synthetic account (its user id or its contact) or this run's sandbox posting;
// anything else is refused before it reaches the database (UNSCOPED). Reads must not write. Exported for its test.
export function scopedDb(raw: Db, scope: { contact: string; email: string; postingKey: string; userId: () => string | null }) {
  const tokens = () => [scope.contact, scope.email, scope.postingKey, ...(scope.userId() ? [scope.userId()!] : [])];
  const check = (text: string) => {
    if (!tokens().some((t) => text.includes(t))) throw new Error(`UNSCOPED query refused (names neither the synthetic account nor this run's posting): ${text.slice(0, 120)}`);
  };
  return {
    read: async (text: string) => {
      check(text);
      if (WRITE.test(text.replace(/'[^']*'/g, "''"))) throw new Error(`a read may not write: ${text.slice(0, 120)}`);
      return (await raw.sql(text)).trim();
    },
    write: async (text: string) => { check(text); return (await raw.sql(text)).trim(); },
  };
}

// Two nonsense words per run (letters only, so the search parser keeps each whole): one names the employer and its place,
// one the role. "Zq" + 8 letters derived from the run id: no dictionary word, no other posting's word.
export function privateTokens(runId: string): { company: string; title: string; place: string } {
  let h = 2166136261;
  const letters = (salt: string) => {
    let out = "";
    for (const ch of salt + runId) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; }
    for (let i = 0; i < 8; i++) { h = Math.imul(h ^ i, 16777619) >>> 0; out += String.fromCharCode(97 + (h % 26)); }
    return out;
  };
  const company = `Zq${letters("company")}`, title = `Zq${letters("title")}`;
  return { company, title, place: company };
}

export function sandboxUrl(runId: string, n = 1): string {
  const u = new URL(`https://${SANDBOX_HOST}/greenhouse/trainee-sandbox-${runId}/jobs/${n}`);
  if (EMPLOYER_HOSTS.test(u.hostname) || !u.hostname.endsWith(".invalid")) throw new Error(`refused: the sandbox employer must be on a reserved .invalid host, never a real employer (${u.hostname})`);
  return u.toString();
}

export async function runJourneys(o: JourneyOpts): Promise<JourneyReport> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!/^[a-z0-9-]{4,40}$/.test(o.runId)) throw new Error("runId must be 4-40 of [a-z0-9-]");
  const contact = `tg:${o.chat}`, email = `tg-${o.chat}@users.trainee.invalid`;
  // Private to this run: every searchable word of the posting (title, company, location, description: the search tsvector)
  // is a nonsense token made from the run id, so no other person's search, which must match every word it asks for, can
  // list it, and no alert keyword can match it. Only the synthetic account asks for these tokens.
  const tok = privateTokens(o.runId);
  const SANDBOX = { job: `greenhouse:trainee-sandbox-${o.runId}:1`, board: `trainee-sandbox-${o.runId}`, company: tok.company, title: tok.title, location: tok.place, description: tok.title, url: sandboxUrl(o.runId) };
  let userId: string | null = null;
  const db = scopedDb(o.db, { contact, email, postingKey: SANDBOX.board, userId: () => userId });
  const json = async (s: string) => JSON.parse((await db.read(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
  const results: StepResult[] = [];
  let upd = Number(`9${String(Date.now()).slice(-8)}`), mid = 1000, updates = 0;
  const replyTimeout = o.replyTimeoutMs ?? 90_000, pace = o.paceMs ?? 0;
  const replyKeys: number[] = [];

  const ok = (v: unknown, m: string) => { if (!v) throw new Error(m); };
  const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
  const send = async (body: Record<string, unknown>) => {
    if (pace && updates) await delay(pace);
    const id = ++upd; updates++;
    const r = await o.post({ update_id: id, ...body });
    eq(r.status, 200, `the webhook took update ${id}`);
    return id;
  };
  // A reply is read from the database (career_outbox, the rows the deliverer sends from), never from Telegram: in live mode
  // the chat is not ours to read. Waits for the reply's first row; returns the reply's text in order.
  const replyOf = async (id: number) => {
    const until = Date.now() + replyTimeout;
    for (;;) {
      if (userId) {
        const rows = await json(`select key, text, status from public.career_outbox where user_id = '${userId}' and (key = 'reply:tg:${id}' or key like 'reply:tg:${id}:%') order by part nulls first, id`);
        if (rows.length) return rows.map((r: any) => String(r.text)).join("\n\n");
      }
      if (Date.now() > until) throw new Error(`no reply row for update ${id} within ${replyTimeout} ms`);
      await delay(1000);
    }
  };
  // fixed: a channel command (STOP) is answered by the webhook itself with a fixed text, not through the outbox.
  const say = async (words: string, fixed = false) => {
    const id = await send({ message: { message_id: ++mid, chat: { id: o.chat, type: "private" }, from: { id: o.chat, is_bot: false, first_name: "Synthetic" }, date: Math.floor(Date.now() / 1000), text: words } });
    if (!userId) {
      const until = Date.now() + replyTimeout;
      while (!userId && Date.now() < until) {
        userId = (await db.read(`select coalesce((select user_id::text from public.channel_contacts where contact = ${q(contact)}), '')`)) || null;
        if (!userId) await delay(500);
      }
      // The marker, at once: the only thing that lets clean-up (this run's or a later one's) erase this account.
      if (userId) await db.write(`insert into public.career_watch_kv (user_id, key, value) values ('${userId}', ${q(MARKER_KEY)}, ${q(JSON.stringify({ run: o.runId, at: new Date().toISOString() }))}::jsonb)
        on conflict (user_id, key) do update set value = excluded.value`);
    }
    if (fixed) return { id, reply: "" };
    replyKeys.push(id);
    return { id, reply: await replyOf(id) };
  };
  const tap = async (data: string) => {
    const id = await send({ callback_query: { id: `cbq-${o.runId}-${++mid}`, from: { id: o.chat, is_bot: false, first_name: "Synthetic" }, message: { message_id: 1, chat: { id: o.chat, type: "private" }, date: 1 }, data } });
    await delay(o.tapWaitMs ?? 3000);
    return id;
  };
  const step = async (id: StepId, fn: () => Promise<void>) => {
    const gap = KNOWN_GAP.includes(id);
    try {
      await fn();
      results.push({ id, outcome: gap ? "KNOWN_GAP NOW PASSES" : "PASS" });
    } catch (e) {
      results.push({ id, outcome: gap ? "KNOWN_GAP still fails" : "FAIL", why: String((e as Error)?.message ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 500) });
    }
    const r = results.at(-1)!;
    log(`LIVE_JOURNEY ${r.id} ${r.outcome}${r.why ? `: ${r.why}` : ""}`);
    return r.outcome === "PASS" || r.outcome === "KNOWN_GAP still fails" || r.outcome === "KNOWN_GAP NOW PASSES";
  };
  const skipRest = (from: StepId) => {
    for (const s of STEPS.slice(STEPS.indexOf(from))) if (s !== "cleanup-erases-everything" && !results.some((r) => r.id === s)) {
      results.push({ id: s, outcome: "SKIPPED", why: "an earlier step failed" }); log(`LIVE_JOURNEY ${s} SKIPPED`);
    }
  };

  // ---------------------------------------------------------------------------------------------------------------- clean-up
  // The synthetic account only: found by the chat's contact, and only when it carries this script's marker and its login
  // address is the chat's own synthetic one. Erases every public table's rows for it (the catalog, as career_erase_person
  // does), its stored files' rows, its contact, its login, and this run's sandbox posting; then proves nothing is left.
  const markedAccount = async (): Promise<string | null> => {
    const u = await db.read(`select coalesce((select c.user_id::text from public.channel_contacts c join auth.users a on a.id = c.user_id
      where c.contact = ${q(contact)} and a.email = ${q(email)} and exists (select 1 from public.career_watch_kv k where k.user_id = c.user_id and k.key = ${q(MARKER_KEY)})), '')`);
    return u || null;
  };
  const erase = async (uid: string) => {
    const was = userId; userId = uid;
    try {
      await db.write(`do $erase$ declare t record; n int; pass int := 0; begin
        if not exists (select 1 from public.career_watch_kv where user_id = '${uid}' and key = ${q(MARKER_KEY)}) then raise exception 'not the synthetic account'; end if;
        loop
          n := 0; pass := pass + 1;
          for t in select c.table_name from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
                   where c.table_schema = 'public' and c.column_name = 'user_id' and tb.table_type = 'BASE TABLE' and c.table_name <> 'career_watch_kv' loop
            begin execute format('delete from public.%I where user_id = %L', t.table_name, '${uid}'); exception when foreign_key_violation then n := n + 1; end;
          end loop;
          exit when n = 0 or pass > 6;
        end loop;
        -- Supabase refuses a direct delete on storage.objects unless the session allows it; a refusal is left for the
        -- leftovers check (and the next run's preflight) rather than aborting the rest of the erase.
        begin perform set_config('storage.allow_delete_query', 'true', true); delete from storage.objects where name like '${uid}/%';
        exception when others then raise notice 'storage objects not erased: %', sqlerrm; end;
        delete from public.career_watch_kv where user_id = '${uid}';
        delete from public.channel_contacts where user_id = '${uid}' or contact = ${q(contact)};
        delete from auth.users where id = '${uid}' and email = ${q(email)};
      end $erase$`);
    } finally { userId = was ?? uid; }
  };
  const leftovers = async (uid: string) => {
    const was = userId; userId = uid;
    try {
      return await db.read(`select coalesce(string_agg(x, ', '), '') from (
        select c.table_name || ':' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where user_id = %L', c.table_name, '${uid}'), false, true, '')))[1]::text as x
        from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'user_id' and tb.table_type = 'BASE TABLE'
        union all select 'auth.users:' || count(*) from auth.users where id = '${uid}'
        union all select 'storage.objects:' || count(*) from storage.objects where name like '${uid}/%'
        union all select 'channel_contacts(contact):' || count(*) from public.channel_contacts where contact = ${q(contact)}
      ) s where x !~ ':0$'`);
    } finally { userId = was; }
  };

  let alive = await step("preflight-synthetic-only", async () => {
    const owner = await db.read(`select coalesce((select user_id::text from public.channel_contacts where contact = ${q(contact)}), '')`);
    if (!owner) return;
    const marked = await markedAccount();
    ok(marked === owner, `the chat ${contact} belongs to an account without the synthetic marker: refusing to touch it (is LIVE_JOURNEY_TELEGRAM_CHAT_ID a real person's chat?)`);
    await erase(marked!); // a previous run's leftovers
    userId = null;
    eq(await db.read(`select count(*) from public.channel_contacts where contact = ${q(contact)}`), "0", "the leftover synthetic account is gone");
  });
  // A run that was killed (a cancelled job, a timeout) never reached its clean-up: its sandbox posting is still there. Every
  // earlier run's posting goes now (this script's own: board trainee-sandbox-*, link on the .invalid host); what the
  // synthetic account held that pointed at one went with its account above.
  if (alive) alive = await step("preflight-stale-postings-swept", async () => {
    const stale = `board like 'trainee-sandbox-%' and board <> ${q(SANDBOX.board)} and url like ${q(`https://${SANDBOX_HOST}/%`)}`;
    const n = await db.write(`with gone as (delete from public.career_postings where ${stale} returning 1) select count(*) from gone`);
    if (Number(n)) log(`LIVE_JOURNEY swept ${n} stale sandbox posting(s) from killed runs`);
    eq(await db.read(`select count(*) from public.career_postings where ${stale}`), "0", "no earlier run's sandbox posting is left");
  });

  try {
    // The sandbox posting: words no person searches (privateTokens), and a link that cannot resolve.
    if (alive) await db.write(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values
      (${q(SANDBOX.job)}, 'greenhouse', ${q(SANDBOX.board)}, ${q(SANDBOX.company)}, ${q(SANDBOX.title)}, ${q(SANDBOX.location)}, ${q(SANDBOX.url)},
       ${q(SANDBOX.description)}, now() - interval '30 days', now(), now())
      on conflict (job_id) do nothing`);

    if (alive) alive = await step("new-account-from-hi", async () => {
      const r = await say("hi");
      ok(userId && /^[0-9a-f-]{36}$/.test(userId), `an account was made for the chat: ${userId}`);
      eq(await db.read(`select count(*) from auth.users where email = ${q(email)}`), "1", "exactly one account for the chat");
      ok(/Trainee/.test(r.reply) && /resume/i.test(r.reply), `the welcome names Trainee and asks for a resume: ${r.reply.slice(0, 200)}`);
    });

    if (alive) alive = await step("resume-confirm-one-record", async () => {
      await say(`here is my resume:\n${o.resume}`);
      eq(await db.read(`select count(*) from public.career_events where user_id = '${userId}' and kind = 'fact_confirmed'`), "0", "a pasted resume confirms nothing");
      await say("yes, that's my resume");
      const rec = await json(`select state, kind from public.career_resume_record where user_id = '${userId}'`);
      eq(rec.map((x: any) => [x.state, x.kind]), [["confirmed", "paste"]], "one confirmed resume record");
      ok(Number(await db.read(`select count(*) from public.career_events where user_id = '${userId}' and kind = 'fact_confirmed'`)) >= 5, "the resume's entries are confirmed facts");
    });

    let search = "", ordinal = "first";
    if (alive) alive = await step("search-lists-sandbox-posting", async () => {
      const r = await say(`find me ${SANDBOX.title} jobs`);
      search = r.reply;
      const line = r.reply.split("\n").find((l) => l.includes(SANDBOX.company));
      ok(line, `the sandbox posting is listed: ${r.reply.slice(0, 400)}`);
      // Production's index may list other postings too: the apply step names the sandbox posting by its place in this list.
      const n = Number(/^(\d+)\. /.exec(line!)?.[1] ?? 1);
      ok(n >= 1 && n <= 5, `the sandbox posting is in the first five: ${line}`);
      ordinal = ["first", "second", "third", "fourth", "fifth"][n - 1];
      ok(r.reply.includes(SANDBOX.url) || r.reply.includes(SANDBOX_HOST), `it carries its own source link: ${line}`);
      eq(await db.read(`select count(*) from public.career_apply_wanted where user_id = '${userId}'`), "0", "a search applies to nothing");
    });

    // While the posting is live: a caller's own check that other people cannot see it (the dry mode searches as a second
    // person here). Production passes nothing; "sandbox-posting-private" below reads the database for the same thing.
    if (alive && o.whilePostingLive) await o.whilePostingLive({ company: SANDBOX.company, title: SANDBOX.title, board: SANDBOX.board });

    if (alive) await step("fit-confirmed-facts-only", async () => {
      ok(/what you've confirmed/.test(search), `the list is ranked by what is confirmed: ${search.slice(0, 300)}`);
      const confirmed = (await db.read(`select coalesce(string_agg(lower(subject), '|'), '') from public.career_events where user_id = '${userId}' and kind = 'fact_confirmed'`));
      for (const skill of ["rust", "kotlin", "swift", "scala"]) ok(new RegExp(`\\b${skill}\\b`).test(confirmed) || !new RegExp(`\\b${skill}\\b`, "i").test(search), `no credit for ${skill}, not on record`);
    });
    if (alive) await step("fit-question-answered", async () => {
      const r = await say("am I a fit for the first one?");
      ok(!/not on your record|not sure which part/i.test(r.reply) && /Python|React|PostgreSQL/.test(r.reply), `a fit answer from confirmed facts: ${r.reply.slice(0, 300)}`);
    });

    let card: { id: string; hash: string; tca: string } | null = null;
    if (alive) alive = await step("approval-card-exact-payload", async () => {
      const want = await say(`apply to the ${ordinal} one`);
      eq(await db.read(`select coalesce(string_agg(posting_key || ' ' || state, ','), '') from public.career_apply_wanted where user_id = '${userId}'`), `${SANDBOX.job} waiting`, `queued to be prepared, nothing approved (${want.reply.slice(0, 200)})`);
      // The preparation worker's output (the seam): the exact payload the card must show and the approval must bind.
      const stamp = JSON.parse((await db.read(`select coalesce((select value::text from public.career_watch_kv where user_id = '${userId}' and key = 'career:account'), '{}')`)) || "{}");
      const sha = "5a".repeat(32);
      await db.write(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${userId}/${sha}.pdf') on conflict (bucket_id, name) do nothing`);
      const pl = `jsonb_build_object('version', 1, 'user_id', '${userId}', 'job_id', ${q(SANDBOX.job)}, 'company', ${q(SANDBOX.company)}, 'url', ${q(SANDBOX.url)},
        'fields', jsonb_build_array(jsonb_build_object('name', 'first_name', 'label', 'First name', 'value', 'Synthetic'), jsonb_build_object('name', 'email', 'label', 'Email', 'value', 'synthetic@sandbox-employer.trainee.invalid')),
        'privacy_epoch', ${Number(stamp.epoch ?? 0)}, 'account_version', ${Number(stamp.version ?? 0)}, 'expires_at', now() + interval '1 day', 'resume_sha256', '${sha}')`;
      const prep = JSON.parse((await db.write(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
        select '${userId}', ${q(SANDBOX.job)}, ${q(SANDBOX.company)}, ${q(SANDBOX.url)}, pl, public.career_apply_payload_hash(pl),
          array[${q(`${SANDBOX.company} — ${SANDBOX.title}`)}, 'First name: Synthetic', 'Email: synthetic@sandbox-employer.trainee.invalid'] from (select ${pl} as pl) x
        returning json_build_object('id', id, 'hash', payload_hash)`)).split("\n")[0]);
      const shown = await say("show my applications");
      ok(shown.reply.includes(SANDBOX.company) && shown.reply.includes("First name: Synthetic"), `the card shows the exact payload: ${shown.reply.slice(0, 300)}`);
      const cards = await json(`select id, items from public.career_apply_cards where user_id = '${userId}' and state = 'open'`);
      eq(cards.length, 1, "one open card");
      eq(cards[0].items.map((i: any) => i.payload_hash), [prep.hash], "the card is bound to the exact payload hash");
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${cards[0].id}|${cards[0].items.map((i: any) => `${i.n}:${i.payload_hash}`).join(",")}`)))]
        .map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
      card = { id: cards[0].id, hash: prep.hash, tca: `tca:${cards[0].id}:${digest}` };
      eq(await db.read(`select count(*) from public.career_apply_jobs where user_id = '${userId}'`), "0", "showing approves nothing");
    });

    if (alive) alive = await step("approve-tap-queues-sandbox-job", async () => {
      await tap(card!.tca);
      let j: any[] = [];
      for (let i = 0; i < 20 && !j.length; i++) { j = await json(`select job_id, state, payload_hash, approval_hash, attempts, url from public.career_apply_jobs where user_id = '${userId}'`); if (!j.length) await delay(1000); }
      eq(j.map((x: any) => [x.job_id, x.state, x.attempts]), [[SANDBOX.job, "queued", 0]], "the tap approved exactly the card: one queued job, nothing attempted");
      eq([j[0].payload_hash, j[0].approval_hash], [card!.hash, card!.hash], "the approval is bound to the payload shown");
      ok(!j[0].url || new URL(j[0].url).hostname === SANDBOX_HOST, `the job points at the sandbox employer only: ${j[0].url}`);
      eq(await db.read(`select count(*) from public.career_apply_receipts where user_id = '${userId}'`), "0", "no receipt: nothing was submitted");
      eq(await db.read(`select count(*) from public.career_apply_cloud_optin where user_id = '${userId}'`), "0", "no cloud path turned on");
      await tap(card!.tca);
      eq(await db.read(`select count(*) from public.career_apply_jobs where user_id = '${userId}'`), "1", "a second tap adds nothing");
    });

    if (alive) await step("status-matches-db", async () => {
      const r = await say("status of my applications");
      const line = r.reply.split("\n").find((l) => l.includes(SANDBOX.company));
      ok(line && /approved, not sent yet/.test(line), `the queued application reads as approved and not sent: ${r.reply.slice(0, 300)}`);
    });

    if (alive) await step("outreach-draft-not-sent", async () => {
      const imported = await say(`and these\nName,Company,Title,Email\nMaya Probe,${SANDBOX.company},Recruiter,maya.probe@sandbox-employer.trainee.invalid\n`);
      ok(/imported 1\/1/.test(imported.reply), `the contact was imported: ${imported.reply.slice(0, 200)}`);
      const ask = await say(`email Maya at ${SANDBOX.company} about the ${SANDBOX.title} role`);
      if (/sign/i.test(ask.reply) && !/Drafted/.test(ask.reply)) await say("Synthetic Tester\nSandbox University");
      const drafts = await json(`select recipient_email, status, approved_hash from public.career_outreach_drafts where user_id = '${userId}'`);
      ok(drafts.length >= 1, `a draft exists: ${ask.reply.slice(0, 200)}`);
      for (const d of drafts) {
        eq(d.recipient_email, "maya.probe@sandbox-employer.trainee.invalid", "only the address from the person's own contacts");
        eq(d.approved_hash, null, "never approved");
        ok(!["sent", "queued", "approved"].includes(d.status), `never sent: ${JSON.stringify(d)}`);
      }
      eq(await db.read(`select count(*) from public.career_send_queue where user_id = '${userId}'`), "0", "nothing on the send rail");
    });

    if (alive) await step("reminder-scheduled", async () => {
      // The person says they sent the email themselves (Trainee sends nothing), then asks for a follow-up reminder.
      await say("sent 1");
      const r = await say("remind me to follow up with Maya in 3 days");
      const due = await db.read(`select coalesce((select value->>'next_due_at' from public.career_watch_kv where user_id = '${userId}' and key = 'career:outreach:followups'), '')`);
      ok(due, `a follow-up reminder is stored: ${r.reply.slice(0, 200)}`);
      const days = (Date.parse(due) - Date.now()) / 86_400_000;
      ok(days > 2 && days < 4.1, `it is due in about 3 days: ${due}`);
      eq(await db.read(`select count(*) from public.career_send_queue where user_id = '${userId}'`), "0", "still nothing on the send rail");
    });

    if (alive) await step("alerts-watch-saved", async () => {
      const r = await say(`watch ${SANDBOX.title} roles for me and alert me when new ones post`);
      const prefs = await json(`select prefs from public.career_alert_prefs where user_id = '${userId}'`);
      ok(prefs.length === 1 && prefs[0].prefs.on === true, `alerts are on: ${r.reply.slice(0, 200)}`);
      ok(JSON.stringify(prefs[0].prefs.keywords).toLowerCase().includes(SANDBOX.title.toLowerCase()), `the watch keeps the person's words: ${JSON.stringify(prefs[0].prefs)}`);
    });

    if (alive) await step("stop-opts-out", async () => {
      await say("STOP", true);
      let out = "";
      for (let i = 0; i < 20 && out !== "true"; i++) { out = await db.read(`select opted_out::text from public.channel_contacts where contact = ${q(contact)}`); if (out !== "true") await delay(500); }
      eq(out, "true", "STOP is recorded: Trainee starts nothing more to this chat");
    });

    if (alive) await step("sandbox-posting-private", async () => {
      // No other account holds anything that points at the sandbox posting (a shortlist, a card, a job, an alert, an
      // outbox row): every public table with a user_id, every row not the synthetic account's, read as text.
      const others = await db.read(`select coalesce(string_agg(x, ', '), '') from (
        select c.table_name || ':' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I t where t.user_id is distinct from %L and t::text like %L',
          c.table_name, '${userId}', ${q(`%${SANDBOX.board}%`)}), false, true, '')))[1]::text as x
        from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'user_id' and tb.table_type = 'BASE TABLE'
        union all select 'career_outbox(text):' || count(*) from public.career_outbox where user_id is distinct from '${userId}' and (text like ${q(`%${SANDBOX.company}%`)} or text like ${q(`%${SANDBOX.title}%`)})
      ) s where x !~ ':0$'`);
      eq(others, "", "no other account has rows pointing at the sandbox posting");
    });

    if (alive) await step("replies-delivered", async () => {
      const rows = await json(`select key, status, contact, provider_ids from public.career_outbox where user_id = '${userId}' and key like 'reply:tg:%'`);
      for (const id of replyKeys) ok(rows.some((r: any) => r.key === `reply:tg:${id}` || r.key.startsWith(`reply:tg:${id}:`)), `the reply to update ${id} has its outbox row`);
      for (const r of rows) eq(r.contact, contact, `a reply goes only to the synthetic chat: ${r.key}`);
      if (o.delivery === "verified") {
        const until = Date.now() + replyTimeout;
        let bad = rows.filter((r: any) => r.status !== "delivered" || !(r.provider_ids?.length));
        while (bad.length && Date.now() < until) {
          await delay(2000);
          const again = await json(`select key, status, provider_ids from public.career_outbox where user_id = '${userId}' and key like 'reply:tg:%'`);
          bad = again.filter((r: any) => r.status !== "delivered" || !(r.provider_ids?.length));
        }
        ok(!bad.length, `Telegram accepted every reply (sendMessage 200 with a message id): not delivered ${JSON.stringify(bad.slice(0, 3))}`);
      } else log("LIVE_JOURNEY delivery UNVERIFIED: no private test chat (LIVE_JOURNEY_TELEGRAM_CHAT_ID); outbox rows asserted, Telegram's answer not checked");
    });
  } finally {
    skipRest("new-account-from-hi");
    await step("cleanup-erases-everything", async () => {
      const uid = userId ?? await markedAccount();
      if (uid) {
        const marked = await markedAccount();
        ok(marked === uid, "the account to erase carries the synthetic marker");
        await erase(uid);
        const left = await leftovers(uid);
        eq(left, "", "nothing of the synthetic account is left");
      }
      userId = uid; // scope for the posting's delete
      await db.write(`delete from public.career_postings where board = ${q(SANDBOX.board)} and url like ${q(`https://${SANDBOX_HOST}/%`)}`);
      eq(await db.read(`select count(*) from public.career_postings where board = ${q(SANDBOX.board)}`), "0", "the sandbox posting is gone");
    });
  }
  // The product's verdict is the journey steps; the clean-up is the harness's own. A clean-up that left rows is reported
  // (exit 3) but is not the product failing, so it never rolls a deploy back; the next run's preflight erases them.
  const journey = results.filter((r) => r.id !== "cleanup-erases-everything");
  const pass = journey.every((r) => r.outcome === "PASS" || r.outcome.startsWith("KNOWN_GAP"));
  const cleanedUp = results.find((r) => r.id === "cleanup-erases-everything")?.outcome === "PASS";
  const gapsNowPassing = results.filter((r) => r.outcome === "KNOWN_GAP NOW PASSES").map((r) => r.id);
  if (gapsNowPassing.length) log(`LIVE_JOURNEY KNOWN_GAP entries that now pass (remove them): ${gapsNowPassing.join(", ")}`);
  log(`LIVE_JOURNEY ${pass ? "PASS" : "FAIL"}${cleanedUp ? "" : " CLEANUP_INCOMPLETE"} delivery=${o.delivery.toUpperCase()} steps=${results.length} pass=${results.filter((r) => r.outcome === "PASS").length} fail=${results.filter((r) => r.outcome === "FAIL").length} skipped=${results.filter((r) => r.outcome === "SKIPPED").length} updates=${updates}`);
  return { results, delivery: o.delivery, pass, cleanedUp, userId, updates };
}

// ------------------------------------------------------------------------------------------------------------------- live
export function psqlDb(url: string): Db {
  return {
    async sql(text: string) {
      const p = new Deno.Command("psql", { args: ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-d", url, "-f", "-"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
      const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(text)); await w.close();
      const out = await p.output();
      const err = new TextDecoder().decode(out.stderr).replaceAll(url, "***");
      if (!out.success) throw new Error(`psql: ${err.trim().slice(0, 400)}`);
      return new TextDecoder().decode(out.stdout).trim();
    },
  };
}

export function liveInputs(env: { get(k: string): string | undefined }): { missing: string[]; webhook?: string; secret?: string; dbUrl?: string; chat: number; delivery: Delivery } {
  const missing: string[] = [];
  // The owner's switch: on only once the synthetic chat may sign up (TRAINEE_ALLOWED_CONTACTS). Off, the run is NOT RUN, so a
  // deploy is never rolled back because the account could not be made.
  if (env.get("LIVE_JOURNEY_ENABLED") !== "true") missing.push("LIVE_JOURNEY_ENABLED=true");
  const ref = env.get("SUPABASE_PROJECT_REF"), base = env.get("SUPABASE_URL") || (ref ? `https://${ref}.supabase.co` : "");
  if (!base) missing.push("SUPABASE_PROJECT_REF");
  const secret = env.get("TELEGRAM_WEBHOOK_SECRET"); if (!secret) missing.push("TELEGRAM_WEBHOOK_SECRET");
  const dbUrl = env.get("SUPABASE_DB_URL"); if (!dbUrl) missing.push("SUPABASE_DB_URL");
  const raw = (env.get("LIVE_JOURNEY_TELEGRAM_CHAT_ID") || "").trim();
  if (raw && !/^[1-9][0-9]{0,15}$/.test(raw)) missing.push("LIVE_JOURNEY_TELEGRAM_CHAT_ID (a private chat's positive id)");
  const chat = raw ? Number(raw) : SYNTHETIC_CHAT;
  return { missing, webhook: base ? `${base.replace(/\/$/, "")}/functions/v1/trainee-telegram` : undefined, secret, dbUrl, chat, delivery: raw ? "verified" : "unverified" };
}

export function webhookPoster(url: string, secret: string) {
  return async (update: Record<string, unknown>) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update), signal: AbortSignal.timeout(150_000) });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  };
}

async function main(args: string[]): Promise<number> {
  const root = new URL("../..", import.meta.url);
  const resume = await Deno.readTextFile(new URL("packages/career-data/fixtures/test-resume.txt", root));
  const runId = (Deno.env.get("GITHUB_RUN_ID") ? `gh${Deno.env.get("GITHUB_RUN_ID")}` : `local${Date.now().toString(36)}`).toLowerCase().slice(0, 40);
  if (args.includes("--dry")) {
    const { runDry } = await import("./live-journeys-dry.ts");
    const r = await runDry({ resume, runId }, { runJourneys, webhookPoster, SYNTHETIC_CHAT });
    return r.pass && r.cleanedUp ? 0 : 1;
  }
  if (!args.includes("--live")) { console.error("usage: live-journeys.ts --live | --dry"); return 2; }
  const i = liveInputs(Deno.env);
  if (i.missing.length) { console.log(`LIVE_JOURNEY NOT RUN: missing ${i.missing.join(", ")} (docs/architect/TEST-STRATEGY-2026-11-01.md, owner inputs)`); return 2; }
  console.log(`LIVE_JOURNEY live run ${runId}: chat ${i.delivery === "verified" ? "the owner's private test chat" : "SYNTHETIC_CHAT (delivery UNVERIFIED)"}, sandbox ${SANDBOX_HOST}`);
  const r = await runJourneys({ post: webhookPoster(i.webhook!, i.secret!), db: psqlDb(i.dbUrl!), chat: i.chat, delivery: i.delivery, runId, resume, paceMs: 1500, replyTimeoutMs: 120_000 });
  return !r.pass ? 1 : r.cleanedUp ? 0 : 3;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
