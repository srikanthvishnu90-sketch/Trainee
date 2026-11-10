// LOOP 11 (item 11, interview preparation; VERIFICATION-15): twelve interview-prep journeys through the REAL handler
// (handleChat) on real Postgres. Each person has a posting on file, a confirmed profile (account memory) and a scheduled
// interview (career_interviews, as the mail reader writes an invite), and asks for prep the way people type it: "help me
// prep for my interview at Acme", "mock me for my interview on Thursday", "prep me for my upcoming interview". Every
// question the mock asks is answered (strong and weak answers mixed), to the debrief; one journey then drills the weak
// spot in a new thread.
//
// Each journey is scored on five checks, and the run prints one line with the totals:
//   tied       every question is tied to the posting (the opener and closer name its title and company; every other
//              question opens "The posting asks for <skill>." and the posting's own text says that skill)
//   feedback   every answer gets feedback tied to that answer: the key points said covered are in the answer, the ones
//              said missing are not, "never said how you would use X" only when the answer never says X, and a weak
//              answer is noted while a strong one is not
//   invented   no claim about the company or team the posting or the invite does not hold (culture, process, rounds,
//              what they look for, a name, a date or a time), and nothing about the person beyond the confirmed profile
//   booked     the interview time is the invite's own words, and a suggested practice time is never said to be booked
//   continues  the mock is bound to the scheduled interview, runs every question across turns, ends in a debrief, is
//              kept as one mock_done event, and (journey 12) its weak spot is drilled in a new thread
// The bar: 0 invented claims, 100% of questions tied to the posting, 12 of 12 journeys passing.
// LOOP11_DUMP=1 prints each journey's first reply.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/loop-11-interview.test.ts
//      (Postgres 16 on PATH or PGBIN=; not as root)
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { bankItems, isInterviewPrepAsk } from "../../supabase/functions/_shared/career_mock_prep.ts";

const CI = Deno.env.get("CI") === "true";
const DAY = 86_400_000;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Journey {
  id: number; company: string; title: string; role: string; jd: string;
  inDays: number; hour: number; format: "video" | "phone" | "onsite"; interviewers?: { name: string; title: string | null }[];
  ref: boolean; // the invite names the application (application_ref job:<id>); otherwise it is matched by company and role
  ask: (when: { weekday: string; said: string }) => string;
  other?: { company: string; title: string; inDays: number }; // a second interview on file
  drill?: boolean;
}
const J: Journey[] = [
  { id: 1, company: "Acme Analytics", title: "Data Analyst, Growth", role: "data analyst", inDays: 3, hour: 14, format: "video", ref: true, interviewers: [{ name: "Dana Kim", title: "Analytics Manager" }],
    jd: "Data Analyst, Growth. Acme Analytics is hiring a Data Analyst for the growth team. You will write SQL against our warehouse, design and read A/B tests with the product team, and apply statistics to product questions. You will build dashboards in Tableau. We want strong communication: you present findings to non-technical stakeholders.",
    ask: () => "help me prep for my interview at Acme" },
  { id: 2, company: "Globex", title: "Software Engineer, Platform", role: "software engineer", inDays: 4, hour: 10, format: "video", ref: true,
    jd: "Software Engineer, Platform. Globex is hiring a software engineer for the platform team. You will build services in Python on AWS, run them on Kubernetes, and work on distributed systems that serve millions of requests. Strong collaboration with product and data teams is required.",
    ask: (w) => `mock me for my interview on ${w.weekday}` },
  { id: 3, company: "Initech", title: "Product Analyst", role: "product analyst", inDays: 5, hour: 11, format: "phone", ref: true,
    jd: "Product Analyst at Initech. You will own the checkout KPIs and metrics, write SQL daily, and run experiments with the product team. Strong communication with stakeholders across teams is required. Excel is a plus.",
    ask: () => "prep me for my upcoming interview" },
  { id: 4, company: "Hooli", title: "Financial Analyst", role: "financial analyst", inDays: 2, hour: 9, format: "onsite", ref: true,
    jd: "Financial Analyst, FP&A. Hooli is hiring a Financial Analyst. You will build financial models in Excel, run DCF valuations for new projects, and present results to stakeholders in finance and operations. Strong communication skills are a must.",
    ask: (w) => `I have an interview with Hooli on ${w.weekday}, can you run a practice interview` },
  { id: 5, company: "Umbrella Health", title: "Data Scientist", role: "data scientist", inDays: 6, hour: 15, format: "video", ref: true,
    jd: "Data Scientist. Umbrella Health is hiring a Data Scientist to build machine learning models in Python, apply statistics to clinical data, and write SQL against our warehouse. You will communicate results to clinicians and product managers.",
    ask: () => "get me ready for my Umbrella Health interview" },
  { id: 6, company: "Vandelay Industries", title: "Business Analyst", role: "business analyst", inDays: 3, hour: 13, format: "video", ref: false,
    jd: "Business Analyst. Vandelay Industries needs a Business Analyst who writes SQL, builds reports in Excel and dashboards in Tableau, and works closely with stakeholders in sales and operations.",
    ask: () => "can we rehearse for my interview with Vandelay" },
  { id: 7, company: "Stark Labs", title: "Backend Engineer", role: "backend engineer", inDays: 7, hour: 16, format: "video", ref: true,
    jd: "Backend Engineer. Stark Labs builds payment services in Go on Postgres. You will design distributed systems, take part in system design reviews, and mentoring junior engineers is part of the role.",
    ask: () => "practice for my Stark Labs interview" },
  { id: 8, company: "Acme Analytics", title: "Data Analyst", role: "data analyst", inDays: 4, hour: 12, format: "phone", ref: true,
    jd: "Data Analyst. Acme Analytics is hiring a Data Analyst. You will write SQL, apply statistics to product questions, and build dashboards in Tableau. Strong communication is required.",
    ask: () => "mock me for the data analyst role at Acme Analytics" },
  { id: 9, company: "Wayne Analytics", title: "Marketing Analyst", role: "marketing analyst", inDays: 5, hour: 10, format: "video", ref: true,
    jd: "Marketing Analyst. Wayne Analytics is hiring a Marketing Analyst. You will write SQL, own campaign metrics, design A/B tests, and communicate results to the marketing team.",
    ask: () => "prep me for my Wayne Analytics interview", other: { company: "Pied Piper", title: "Data Engineer", inDays: 2 } },
  { id: 10, company: "Soylent", title: "Product Manager", role: "product manager", inDays: 8, hour: 14, format: "onsite", ref: false,
    jd: "Product Manager, Growth. Soylent is hiring a Product Manager. You will define product metrics, work with stakeholders across engineering and design, show leadership on cross-team launches, and handle ambiguity in a fast-paced team.",
    ask: () => "help me practice for my interview" },
  { id: 11, company: "Cyberdyne", title: "Machine Learning Engineer", role: "machine learning engineer", inDays: 6, hour: 11, format: "video", ref: true,
    jd: "Machine Learning Engineer. Cyberdyne is hiring an engineer to train machine learning models in Python, ship them on AWS, and collaborate with research and product teams.",
    ask: () => "mock interview for my upcoming Cyberdyne interview" },
  { id: 12, company: "Tyrell", title: "Data Analyst", role: "data analyst", inDays: 3, hour: 15, format: "video", ref: true, drill: true,
    jd: "Data Analyst. Tyrell is hiring a Data Analyst to write SQL, apply statistics to customer questions, build dashboards, and communicate findings to stakeholders.",
    ask: () => "prep me for my interview at Tyrell" },
];
const PROFILE = [
  { kind: "education", title: "State University, B.S. Economics", text: "State University, B.S. Economics, 2026", status: "confirmed", needs_confirmation: false },
  { kind: "experience", title: "Research Assistant, State University Economics Lab", text: "Research Assistant, State University Economics Lab (2024-2026): cleaned survey data in SQL and Python", status: "confirmed", needs_confirmation: false },
  { kind: "skill", text: "Skill: SQL", status: "confirmed", needs_confirmation: false },
];
const STORY = "At my research assistant job the lab's survey data had duplicate rows. I owned the cleanup: I wrote the SQL to find them, checked a sample by hand, and rebuilt the weekly report. The duplicate rate fell from 9% to under 1%, measured on the next three survey waves.";
const OPENER = "I studied economics at State University and worked as a research assistant in the economics lab, where I cleaned survey data in SQL and Python. This role uses the same skills on product questions.";
const WEAK = "I would just look at the numbers and see.";
const uid = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000000011${String(n).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/'/g, "''");

// What a requirement label must match in the posting's own text for a question to be tied to it.
const LABEL_IN_JD: Record<string, RegExp> = {
  "A/B testing": /\bexperiment|\ba\/b test/i, dashboards: /dashboard|reporting|visuali/i, "working with stakeholders": /stakeholder|cross-functional|partner with/i,
  communication: /communicat|present(?:ing)? (?:findings|results|insights)/i, teamwork: /collaborat|teamwork|team player/i, statistics: /statistic/i,
  metrics: /\bmetrics?\b|\bkpis?\b/i, "product sense": /\bproduct (?:sense|thinking|analytics|metrics|management)\b/i, "handling ambiguity": /ambigu|fast-paced/i,
  "financial modeling": /financial model/i, DCF: /\bdcf\b|discounted cash flow/i, "machine learning": /machine learning|\bml\b/i, "distributed systems": /distributed/i,
  "system design": /system design/i, leadership: /leadership|lead (?:projects|initiatives|a team)|ownership/i, mentoring: /mentor/i, Excel: /excel|spreadsheet/i, SQL: /\bsql\b/i,
};
const labelIn = (label: string, jd: string) => (LABEL_IN_JD[label] ?? new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")).test(jd);
const covered = (answer: string, key: string) => {
  const a = ` ${answer.toLowerCase().replace(/[_-]/g, " ").replace(/[^a-z0-9/ ]+/g, " ")} `;
  const ws = key.toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  return ws.length > 0 && ws.filter((w) => a.includes(` ${w.slice(0, 5)}`)).length * 2 >= ws.length;
};
const lastQ = (reply: string) => /Q(\d+) of (\d+): ([^\n]+)\s*$/.exec(reply);

// A strong answer to a technical question: the bank item's key points, the requirement named, and a result with a
// number. For a question with no bank item, the requirement named with a real-shaped example.
function strongAnswer(q: string, role: string): string {
  const label = /The posting asks for ([^.]+)\./.exec(q)?.[1] ?? "it";
  const it = bankItems(role).find((x) => q.includes(x.q));
  const keys = it ? `I would cover ${it.keys.join(", ")}. ` : "";
  return `For ${label}, ${keys}I used ${label} on a class project: I wrote it up, checked it against a hand count, and the team used it to cut a 3-day report to 2 hours.`;
}

// ---------- the claim scan ----------
// A claim about the company, the team or the interview that only a source could back.
const COMPANY_CLAIM = /\b(?:culture|core values|their values|mission is|known for|famous for|founded in|headquartered|hiring bar is|they (?:look for|value|care about|usually|tend to|prefer)|the team (?:is|uses|values|works|prefers)|their team (?:is|uses)|interview process (?:is|has|includes)|(?:first|second|third|final|onsite) round (?:is|will)|the interviewers? (?:will|usually|tend|likes?)|recruiter will|expect (?:a|an|two|three) rounds?)\b/i;
// A claim about the person's own history.
const PERSON_CLAIM = /\byou(?:'ve| have| had)? (?:worked|interned|studied|graduated|built|led|managed|shipped) (?:at|as|on|in|for)? ?([A-Z][\w&.-]*(?: [A-Z][\w&.-]*)*)?/g;
// Words the product itself says with a capital letter (not facts about anyone).
const PRODUCT_WORDS = new Set(["Q", "I", "Mock", "Text", "Debrief", "Answer", "Average", "Strongest", "Weakest", "Weak", "Weak-spot", "Next", "Against", "Each", "Tell", "Why", "Walk", "The", "Talk",
  "Same", "Still", "Every", "No", "Redo", "Practice", "Add", "Name", "Put", "Strong", "Good", "Make", "One", "It", "SQL", "A/B", "Tableau", "Python", "Excel", "DCF", "AWS", "Kubernetes", "Go", "Postgres",
  "Power", "BI", "Looker", "R", "Java", "JavaScript", "React", "Rust", "ETL", "For", "Suggested", "Before", "Your", "Trainee", "STAR", "Interview", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]);
const DATEISH = new RegExp(String.raw`\b(?:${WEEKDAY.join("|")}|${MONTH.join("|")})\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b(?:CT|ET|PT|MT|UTC)\b`, "g");
const BOOKED = /\b(?:booked|blocked (?:off|out|time)|added (?:it |this )?to your calendar|on your calendar|calendar invite|i(?:'ve| have) scheduled|scheduled (?:it|your practice|a practice|the mock)|reminder is set|i(?:'ll| will) remind you)\b/i;
const NEGATED = /\b(?:not|nothing|never|no)\b/i;

interface Score { tied: number; asked: number; fbOk: number; answers: number; invented: string[]; booked: string[]; continues: string[]; fbBad: string[]; untied: string[] }

Deno.test({ name: "LOOP 11: twelve interview-prep journeys with a posting, a confirmed profile and a scheduled interview, through handleChat", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const now = Date.now();
  const whenOf = (inDays: number, hour: number) => {
    const d = new Date(now + inDays * DAY);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const h12 = hour % 12 || 12, ap = hour < 12 ? "am" : "pm";
    // CT in November is UTC-6.
    const starts = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour + 6)).toISOString();
    return { date, time: `${String(hour).padStart(2, "0")}:00`, starts, weekday: WEEKDAY[d.getUTCDay()], said: `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()} at ${h12}${ap} CT` };
  };
  try {
    await supabaseParity(pg);
    const people: Record<string, string> = {};
    for (const j of J) {
      const me = uid(j.id), job = `greenhouse:j${j.id}:1`;
      people[`tok-${j.id}`] = me;
      const memory = JSON.stringify({ epoch: 0, version: 0, paused: false, memory: { v: 1, profile: { facts: PROFILE }, tracker: null, updated_at: new Date(now).toISOString() } });
      const payload = JSON.stringify({ version: "1", user_id: me, job_id: job, company: j.company, url: `https://j${j.id}.example.test/apply`, fields: [], title: j.title });
      const w = whenOf(j.inDays, j.hour);
      const rows = [{ company: j.company, title: j.title, w, ref: j.ref ? `'job:${job}'` : "null", key: "a" }];
      if (j.other) rows.push({ company: j.other.company, title: j.other.title, w: whenOf(j.other.inDays, 10), ref: "null", key: "b" });
      await pg.sql(`insert into auth.users (id, email) values ('${me}', 'j${j.id}@example.test'); insert into public.profiles (id) values ('${me}');
        insert into public.career_watch_kv (user_id, key, value) values ('${me}', 'career:account', '${esc(memory)}'::jsonb);
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
          values ('${job}', 'greenhouse', 'j${j.id}', '${esc(j.company)}', '${esc(j.title)}', 'Chicago, IL', 'https://j${j.id}.example.test/jobs/1', '${esc(j.jd)}', now(), now());
        set session_replication_role = replica;
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at, updated_at)
          values ('${me}', '${job}', '${esc(j.company)}', 'https://j${j.id}.example.test/apply', '${esc(payload)}'::jsonb, repeat('b', 64), repeat('b', 64), 'submitted_unconfirmed', now() - interval '6 days', now() - interval '6 days');
        set session_replication_role = origin;
        ${rows.map((r) => `insert into public.career_interviews (user_id, invite_key, source, application_ref, company, role, when_said, interview_date, interview_time, zone, starts_at, format, interviewers, mail_at, seen_at)
          values ('${me}', repeat('${r.key}', 64), 'mail', ${r.ref}, '${esc(r.company)}', '${esc(r.title)}', '${esc(JSON.stringify([r.w.said]))}'::jsonb, '${r.w.date}', '${r.w.time}', 'America/Chicago', '${r.w.starts}',
            '${j.format}', '${esc(JSON.stringify(r.key === "a" ? j.interviewers ?? [] : []))}'::jsonb, now() - interval '1 day', now() - interval '1 day');`).join("\n")}`);
    }
    handler = await careerHandler(pg, people);
    const events = async (me: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('subject', subject, 'detail', detail) order by id), '[]') from public.career_events where user_id = '${me}' and kind = 'mock_done'`));
    const S: Score = { tied: 0, asked: 0, fbOk: 0, answers: 0, invented: [], booked: [], continues: [], fbBad: [], untied: [] };
    const passed: number[] = [];

    for (const j of J) {
      await t.step(`journey ${j.id}: ${j.ask(whenOf(j.inDays, j.hour))}`, async () => {
        const me = uid(j.id), w = whenOf(j.inDays, j.hour);
        const before = { invented: S.invented.length, booked: S.booked.length, continues: S.continues.length, fb: S.fbBad.length, untied: S.untied.length };
        const chat: Chat = handler!.chat(`tok-${j.id}`);
        const said: string[] = [], replies: string[] = [];
        const say = async (c: Chat, m: string) => { said.push(m); const r = await c.say(m); assertNode.equal(r.status, 200, r.reply); replies.push(r.reply); return r; };
        const start = await say(chat, j.ask(w));
        if (Deno.env.get("LOOP11_DUMP")) console.log(`\n### J${j.id} > ${j.ask(w)}\n${start.reply}`);
        const miss = (why: string) => S.continues.push(`J${j.id}: ${why}`);
        if (start.intent !== "career_mock") miss(`not a mock (${start.intent}): ${start.reply.slice(0, 160)}`);
        if (!/built from the posting/.test(start.reply)) miss("the mock is not bound to the posting");
        if (!start.reply.includes(w.said)) miss(`the scheduled interview (${w.said}) is not named`);
        // The questions, each answered, to the debrief.
        let reply = start.reply, n = 0, total = 0, weakGiven = 0;
        while (true) {
          const m = lastQ(reply);
          if (!m) break;
          n++; total = Number(m[2]);
          if (n > 10) { miss("more than 10 questions"); break; }
          const q = m[3];
          S.asked++;
          const req = /^The posting asks for ([^.]+)\./.exec(q)?.[1];
          const tied = req ? labelIn(req, j.jd) : (q.includes(j.title) && q.includes(j.company)) || q === `Why ${j.company}, specifically?`;
          if (tied) S.tied++; else S.untied.push(`J${j.id} Q${n}: ${q}`);
          const technical = !!req && !/^The posting asks for (?:communication|working with stakeholders|teamwork|leadership|mentoring|handling ambiguity)\./.test(q);
          const giveWeak = technical && weakGiven === 0 && (n % 2 === 0 || j.drill);
          const answer = /^Tell me about yourself/.test(q) ? OPENER : technical ? (giveWeak ? WEAK : strongAnswer(q, j.role)) : /^Why /.test(q) ? `The posting's focus on ${j.jd.split(".")[1]?.trim().toLowerCase()} is the work I want to do, and it matches what I did in the economics lab.` : STORY;
          if (giveWeak) weakGiven++;
          const r = await say(chat, answer);
          reply = r.reply;
          S.answers++;
          // Feedback tied to this answer.
          const head = r.reply.split(/\nQ\d+ of \d+:|\n\nDebrief|\nDebrief|\n\n/)[0];
          const bad: string[] = [];
          if (!/\d+ of 15\./.test(head)) bad.push("no score");
          const cov = /Answer key: you covered ([^;.]+)/.exec(head)?.[1];
          if (cov) for (const k of cov.split(/, /)) if (!covered(answer, k)) bad.push(`said covered but not in the answer: ${k}`);
          const none = /Answer key: ([^;]+); none of it came up\./.exec(head)?.[1];
          if (none) for (const k of none.split(/, /)) if (covered(answer, k)) bad.push(`said missing but in the answer: ${k}`);
          const never = /The posting asks for ([^,]+), and the answer never said how you would use it\./.exec(head)?.[1];
          if (never && new RegExp(`\\b${never.replace(/[/]/g, "\\/")}\\b`, "i").test(answer)) bad.push(`said never used ${never} but the answer says it`);
          if (giveWeak && !/Weak spot noted/.test(head)) bad.push("a weak answer was not noted");
          if (!giveWeak && technical && /Weak spot noted/.test(head)) bad.push("a strong answer was noted weak");
          if (technical && !/Answer key:|The posting asks for|speaks to the posting/.test(head)) bad.push("no check against the posting");
          if (bad.length) S.fbBad.push(`J${j.id} Q${n}: ${bad.join("; ")} | ${head.slice(0, 200)}`); else S.fbOk++;
        }
        if (!n || n !== total) miss(`asked ${n} of ${total} questions`);
        if (!/^Debrief, /m.test(reply)) miss("no debrief at the end");
        const ev = await events(me);
        if (ev.length !== 1) miss(`${ev.length} mock_done events`);
        else if (ev[0].detail?.posting?.job_id !== `greenhouse:j${j.id}:1`) miss(`the event is not bound to the posting: ${JSON.stringify(ev[0].detail?.posting ?? null)}`);
        if (j.drill) {
          const fresh = handler!.chat(`tok-${j.id}`);
          const d = await say(fresh, "drill my weak spots");
          // One question for each weak spot on file, the posting's SQL first (the strict rubric may also keep the opener or
          // the closer); each answered strongly, to the drill's debrief, and SQL is off the list after it.
          if (!/^Weak-spot drill: \d+ questions?, one for each weak spot on file: SQL\b/.test(d.reply) || !/The posting asks for SQL\./.test(lastQ(d.reply)?.[3] ?? "")) miss(`the drill: ${d.reply.slice(0, 200)}`);
          else {
            let r = d, k = 0;
            while (lastQ(r.reply) && k++ < 6) {
              const q = lastQ(r.reply)![3];
              r = await say(fresh, /The posting asks for/.test(q) ? strongAnswer(q, j.role) : /yourself/.test(q) ? `${OPENER} ${STORY}` : STORY);
            }
            if (!/^Debrief, /m.test(r.reply)) miss(`the drill ended without a debrief: ${r.reply.slice(0, 200)}`);
            const left = await say(fresh, "what are my weak spots");
            if (/\bSQL\b/.test(left.reply)) miss(`SQL is still weak after a strong drill answer: ${left.reply.slice(0, 200)}`);
          }
        }
        // Nothing invented, nothing booked.
        // What a reply may say: the posting, the invite, the confirmed profile, the person's own words, and the role's
        // question bank (its questions and answer keys are sourced interview material, not claims about this company).
        const bank = bankItems(j.role).map((x) => `${x.q} ${x.keys.join(" ")}`);
        const corpus = [j.jd, j.company, j.title, w.said, JSON.stringify(j.interviewers ?? []), JSON.stringify(PROFILE), ...said, ...bank].join("\n");
        const low = corpus.toLowerCase();
        for (const text of replies) {
          for (const sentence of text.split(/(?<=[.?!])\s+|\n+/)) {
            const c = COMPANY_CLAIM.exec(sentence);
            if (c && !low.includes(sentence.toLowerCase().trim())) S.invented.push(`J${j.id} company claim "${c[0]}": ${sentence}`);
            for (const m of sentence.matchAll(PERSON_CLAIM)) if (m[1] && !low.includes(m[1].toLowerCase())) S.invented.push(`J${j.id} person claim: ${sentence}`);
            // A name not at the start of a sentence must be on file.
            // (A product command in quotes, "mock me for data analyst at Acme", is an example of what to text, not a claim.)
            for (const m of sentence.replace(/"[^"]*"/g, '""').matchAll(/(?<=[a-z,;:(] )([A-Z][a-zA-Z&]+(?: [A-Z][a-zA-Z&]+)*)/g)) {
              const words = m[1].split(" ").filter((x) => !PRODUCT_WORDS.has(x) && !WEEKDAY.includes(x) && !MONTH.includes(x));
              for (const x of words) if (!low.includes(x.toLowerCase())) S.invented.push(`J${j.id} name "${x}": ${sentence}`);
            }
            for (const m of sentence.matchAll(DATEISH)) if (!w.said.includes(m[0]) && !said.some((s) => s.includes(m[0]))) S.invented.push(`J${j.id} a date or time not on the invite "${m[0]}": ${sentence}`);
            if (BOOKED.test(sentence) && !NEGATED.test(sentence)) S.booked.push(`J${j.id}: ${sentence}`);
          }
        }
        const ok = S.invented.length === before.invented && S.booked.length === before.booked && S.continues.length === before.continues && S.fbBad.length === before.fb && S.untied.length === before.untied;
        if (ok) passed.push(j.id);
      });
    }
    const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "0.0");
    console.log([...S.untied, ...S.fbBad, ...S.invented, ...S.booked, ...S.continues].map((x) => `  - ${x}`).join("\n"));
    console.log(`LOOP-11 journeys ${passed.length}/12 | questions tied ${S.tied}/${S.asked} (${pct(S.tied, S.asked)}%) | feedback tied ${S.fbOk}/${S.answers} (${pct(S.fbOk, S.answers)}%) | invented ${S.invented.length} | booked ${S.booked.length} | continuity misses ${S.continues.length}`);
    assertNode.equal(S.invented.length, 0, "0 invented claims");
    assertNode.equal(S.tied, S.asked, "100% of questions tied to the posting");
    assertNode.ok(S.asked >= 12 * 3, "every journey asked questions");
    assertNode.equal(S.fbOk, S.answers, "every answer's feedback tied to it");
    assertNode.equal(S.booked.length, 0, "a suggested time is never said to be booked");
    assertNode.deepStrictEqual(passed, J.map((j) => j.id), "12 of 12 journeys");
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });

Deno.test("LOOP 11: what counts as a practice ask about the person's own interview", () => {
  for (const yes of ["help me prep for my interview at Acme", "mock me for my interview on Thursday", "prep me for my upcoming interview", "get me ready for my Umbrella Health interview",
    "I have an interview with Hooli on Friday, can you run a practice interview", "can we rehearse for my interview with Vandelay", "practice for my Stark Labs interview",
    "help me practice for my interview", "mock interview for my upcoming Cyberdyne interview", "Prep me for my interview at Vantek Systems."]) assertNode.ok(isInterviewPrepAsk(yes), yes);
  for (const no of ["mock me for the data analyst role at Acme", "can you give me a practice interview for data analyst at Acme", "mock interview for data analyst at Globex",
    "Can you give me a day-by-day plan to prepare for my finance interview over the next two weeks?", "how should I prepare for my interview tomorrow?",
    "can you make me a plan to prepare for my interview next week?", "Help me prepare an answer before my interview starts", "I'm in my interview right now, help",
    "I have a Plaid interview Friday, add it to my tracker and prep me for my Plaid interview", "how do I prepare for my interview at Acme", "what are my weak spots"]) assertNode.ok(!isInterviewPrepAsk(no), no);
});
