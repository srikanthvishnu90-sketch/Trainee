// R10 (owner order 2026-11-09), WO-I fix 15: the two observed scenarios replayed with the SAME context and the SAME words
// (spec A.2; tests/architect/helpers/r10_turns.ts). The person has an earlier resume intake (uploaded as a PDF and confirmed),
// an old job list (five ML roles, the first the Reddit manager role tailoring picked on production) and the original file is
// no longer available. Every turn goes through the real Telegram webhook into the real agent-chat; every judgement is on what
// came out: the delivered file's bytes (opened, pages counted, text compared with the intake), the links (followed and opened),
// the employer pages (whether a role called open was ever checked), and the database (nothing applied).
//
// EXPECTED TO FAIL ON TRUNK (it is the gate for WO-A to WO-H). Moves to tests/architect/ when the orders land; never weakened.
// Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/r10-app-layer/r10-observed-replay.test.ts
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, inventedNumbers, EMAIL, PHONE, renderPhone } = R;
const FILE = "r10-observed-replay.test.ts";
const CHAT = 7_910_001, CHAT_B = 7_910_002;
const [T1, T2, T3] = T.SCENARIOS.resume, [S1, S2] = T.SCENARIOS.search;
const DA = /data analyst intern/i;

// The resume a reply delivered must be: a real file, one page, the requested target, the person's own facts and nothing else.
async function resumeChecks(w: any, said: any, label: string, ev: any) {
  const files = await deliveredFiles(w, CHAT, said, label, ev);
  const pdfs = files.filter((f: any) => f.kind === "pdf");
  ok(pdfs.length >= 1, `${label}: a PDF was delivered (attachment or working link). Docs: ${JSON.stringify(said.docs.map((d: any) => d.filename))}; links: ${JSON.stringify(said.links)}; reply: ${said.reply.slice(0, 400)}`);
  for (const f of pdfs) {
    ok(f.pdf.ok, `${label}: ${f.name} opens as a PDF: ${f.pdf.why}`);
    ok(f.pdf.pages === 1, `${label}: ${f.name} is one page (it has ${f.pdf.pages})`);
    ok(f.pdf.text.trim().length > 200, `${label}: ${f.name} has selectable text (${f.pdf.text.length} chars)`);
    ok(f.pdf.text.includes(T.INTAKE_NAME), `${label}: ${f.name} carries the person's own name from the intake`);
    for (const fact of ["Granite Peak Partners", "Halcyon Advisory", "Python"]) ok(f.pdf.text.includes(fact), `${label}: ${f.name} keeps the supplied fact "${fact}"`);
    ok(!/Machine Learning Engineering Manager|\breddit\b|Ads Conversion/i.test(f.pdf.text), `${label}: ${f.name} is not aimed at the old Reddit ML manager role`);
    ok(DA.test(f.pdf.text) || /data[_ -]?analyst/i.test(f.name), `${label}: ${f.name} names the data analyst internship target (text or filename)`);
    ok(!/^Resume_Resume\.pdf$/i.test(f.name), `${label}: a meaningful filename, not ${f.name}`);
    ok(!EMAIL.test(f.pdf.text) && !PHONE.test(f.pdf.text), `${label}: no contact detail the person never supplied is printed`);
    ok(/contact|email/i.test(f.pdf.text + said.reply) && /add|confirm|missing|fill|placeholder/i.test(f.pdf.text + said.reply), `${label}: the missing contact details are marked or asked about`);
    ok(!(/3\.6/.test(f.pdf.text) && /3\.8/.test(f.pdf.text)), `${label}: the two conflicting GPA values are not both printed`);
    ok(!/GPA/.test(f.pdf.text) || /GPA/i.test(said.reply), `${label}: a printed GPA is asked about, the sources conflict`);
    const invented = inventedNumbers(f.pdf.text, T.INTAKE_RESUME);
    ok(invented.length === 0, `${label}: no number the person never supplied (${invented.join(", ")})`);
    ok(!/Machine Learning|PyTorch|Kubernetes/i.test(f.pdf.text), `${label}: no skill from a posting that is not in the intake`);
    ok(f.pdf.minFontPt === null || f.pdf.minFontPt >= 8, `${label}: readable type (smallest font ${f.pdf.minFontPt} pt)`);
    ok(f.pdf.outOfPage === 0, `${label}: ${f.pdf.outOfPage} text placement(s) fall outside the page (clipped)`);
  }
  // Claims match what was delivered: "PDF and DOCX" only when both came; "attached" only when something was attached.
  if (/\bDOCX\b|Word file/i.test(said.reply)) ok(files.some((f: any) => f.kind === "docx" && f.docx?.ok), `${label}: the reply names a DOCX, so a DOCX that opens must come with it`);
  if (/\battached\b/i.test(said.reply)) ok(said.docs.length >= 1, `${label}: "attached" with no attachment`);
  for (const f of files.filter((x: any) => x.kind === "docx")) ok(f.docx.ok && f.docx.text.includes(T.INTAKE_NAME), `${label}: the DOCX ${f.name} opens and carries the person's name`);
  ok(/review draft|not ready|before (you|it|this) (is )?(sen[dt]|submit)|unconfirmed|not for (external|employer)/i.test(said.reply + pdfs.map((f: any) => f.pdf.text).join(" ")), `${label}: says the draft is not ready for external use while facts are open`);
  return files;
}

R.suite(FILE, [1, 2, 3, 4, 5, 6, 7, 8, 15], [CHAT, CHAT_B], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  const noApply = async (label: string) => {
    ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)) === "0", `${label}: nothing was put on the apply list`);
    ok((await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)) === "0", `${label}: nothing was approved`);
    ok((await w.sql(`select count(*) from public.career_send_queue where user_id = '${person}'`)) === "0", `${label}: nothing on the send rail`);
  };
  const turn = async (ev: any, words: string, chat = CHAT) => { const s = await w.say(chat, words); ev.reply = s.reply; ev.turns++; ev.scenario = chat === CHAT ? "resume" : "search"; return s; };
  const passed: boolean[] = [];
  const c = async (...a: Parameters<typeof check>) => { const r = await check(...a); passed.push(r); return r; };
  const notObserved = (id: string, reply: string) => { for (const r of T.OBSERVED_FAILURES[id]) ok(!r.test(reply), `${id}: the observed failure again (${r.source}): ${reply.slice(0, 500)}`); };

  // ------------------------------------------------------------------------------------------------ scenario 1: resume
  let t1: any = null, t2: any = null;
  await c(t, FILE, 4, "T1 delivers the one-page data analyst internship PDF from the saved intake", async (ev: any) => {
    t1 = await turn(ev, T1.text);
    notObserved("T1", t1.reply);
    ok(!/name the role|which role|what role/i.test(t1.reply), `T1: the role was given; it is not asked again: ${t1.reply.slice(0, 300)}`);
    await resumeChecks(w, t1, "T1", ev);
    ok(/original/i.test(t1.reply) && /saved|intake|notes|record/i.test(t1.reply), `T1: says it was built from the saved intake because the original file is unavailable: ${t1.reply.slice(0, 400)}`);
    await noApply("T1");
  }, w);
  await c(t, FILE, 1, "T2 keeps the data analyst internship target (never the first role of the old list)", async (ev: any) => {
    t2 = await turn(ev, T2.text);
    notObserved("T2", t2.reply);
    ok(DA.test(t2.reply) || /data analyst internship/i.test(t2.reply), `T2: the reply names the requested target: ${t2.reply.slice(0, 300)}`);
    await resumeChecks(w, t2, "T2", ev);
    await noApply("T2");
  }, w);
  await c(t, FILE, 3, "T2 asks the specific open questions (contact, GPA) and does not re-ask facts on file", async (ev: any) => {
    ev.reply = t2?.reply ?? "";
    ok(t2, "T2 ran");
    ok(/\?/.test(t2.reply), `T2: a specific question is asked: ${t2.reply.slice(0, 400)}`);
    ok(/(email|phone|contact)/i.test(t2.reply) || /GPA/i.test(t2.reply), `T2: the question names the actual open fact: ${t2.reply.slice(0, 400)}`);
    ok(!/what (is|'s) your name|your school|which university|what did you do at/i.test(t2.reply), `T2: does not ask for a fact the intake already holds: ${t2.reply.slice(0, 400)}`);
  }, w);
  await c(t, FILE, 2, "T3 'wrong role' repairs the target, sends a working download link, and starts no batch", async (ev: any) => {
    const t3 = await turn(ev, T3.text);
    await noApply("T3");
    notObserved("T3", t3.reply);
    ok(/wrong role|used the wrong|my mistake|picked the wrong|you're right/i.test(t3.reply), `T3: acknowledges the mismatch: ${t3.reply.slice(0, 300)}`);
    ok(!/\bbatch\b|apply list|top \d+ .* jobs/i.test(t3.reply), `T3: "Don't apply to anything" is not read as a batch: ${t3.reply.slice(0, 300)}`);
    ok((t3.reply.match(/wrong role|used the wrong|my mistake/gi) ?? []).length <= 1, "T3: acknowledges once");
    const files = await resumeChecks(w, t3, "T3", ev);
    const viaLink = files.filter((f: any) => f.via === "link" && f.kind === "pdf");
    ok(viaLink.length >= 1, `T3: the download link was asked for and must open the PDF (links seen: ${JSON.stringify(t3.links)})`);
  }, w);
  await c(t, FILE, 8, "the resume replies are direct: no internal process language, no repeated sentences, short", async (ev: any) => {
    for (const [id, s] of [["T1", t1], ["T2", t2]] as const) {
      ok(s, `${id} ran`);
      ev.reply += `${id}: ${s.reply}\n`;
      ok(!/I found no posting|roles? (that )?fit your profile|Here they are by fit/i.test(s.reply), `${id}: a resume request is answered as a resume task, not a job search: ${s.reply.slice(0, 300)}`);
      ok(internalHits(s.reply).length === 0, `${id}: internal language (${internalHits(s.reply).join(", ")}): ${s.reply.slice(0, 400)}`);
      ok(repeated(s.reply).length === 0, `${id}: repeats itself: ${repeated(s.reply).join(" | ")}`);
      ok(s.reply.length <= 1400, `${id}: ${s.reply.length} characters for a one-file task`);
    }
  }, w);

  // ------------------------------------------------------------------------------------------------ scenario 2: search
  const searcher = await w.observedPerson(CHAT_B);
  let s1: any = null;
  const listed = (reply: string) => reply.split("\n").filter((l: string) => /^\s*\d+[.)]\s/.test(l));
  const blockOf = (reply: string, company: string) => { const i = reply.indexOf(company); if (i < 0) return ""; const rest = reply.slice(i); const next = rest.slice(1).search(/\n\s*\d+[.)]\s/); return next < 0 ? rest : rest.slice(0, next + 1); };
  await c(t, FILE, 5, "S1 returns a usable shortlist: only open Chicago data analyst internships, each with company, role, location, link and checked date", async (ev: any) => {
    s1 = await turn(ev, S1.text, CHAT_B);
    notObserved("S1", s1.reply);
    const want = T.MARKET.filter((m: any) => m.s1);
    for (const m of want) ok(s1.reply.includes(m.company), `S1: the open match ${m.company} is listed: ${s1.reply.slice(0, 600)}`);
    for (const m of T.MARKET.filter((x: any) => !x.s1 && (x.page === "stale" || /Senior/.test(x.title) || /Toronto/.test(x.location)))) ok(!s1.reply.includes(m.company) || m.company === "Lakefront Transit Analytics", `S1: ${m.company} (${m.title}) does not meet the ask and is not listed`);
    ok(!/Senior Data Analyst/.test(s1.reply), "S1: a senior role is not an internship");
    for (const m of want) {
      const b = blockOf(s1.reply, m.company);
      ok(b.includes(m.title), `S1: ${m.company}'s exact title "${m.title}": ${b}`);
      ok(b.includes(m.location.split(" (")[0]) || b.includes(m.location), `S1: ${m.company}'s location: ${b}`);
      ok(b.includes(m.url) || s1.buttons.some((x: any) => x.url === m.url), `S1: ${m.company}'s application link (${m.url}): ${b}`);
      ok(/checked/i.test(b), `S1: ${m.company} carries a checked date: ${b}`);
    }
    const n = want.length;
    ok(new RegExp(`\\b(${n}|three)\\b`, "i").test(s1.reply.split("\n").slice(0, 3).join(" ")), `S1: the count sentence comes from the actual results (${n}): ${s1.reply.slice(0, 300)}`);
    ok(/(not|n't) find (five|5)|only (three|3)|fewer than (five|5)|(three|3) of the (five|5)/i.test(s1.reply), `S1: says plainly fewer than the five asked were verified: ${s1.reply.slice(0, 300)}`);
    await noApplyFor(w, searcher, "S1");
  }, w);
  await c(t, FILE, 6, "S1 calls a role open only after its employer page was opened; a closed page is not listed as open", async (ev: any) => {
    ok(s1, "S1 ran");
    ev.reply = s1.reply;
    for (const m of T.MARKET.filter((x: any) => x.s1)) ok(s1.pageChecks.includes(m.url), `S1: ${m.company}'s employer page was opened before calling it open (checked: ${JSON.stringify(s1.pageChecks)})`);
    const closed = T.MARKET.find((x: any) => x.page === "closed")!;
    ok(!s1.reply.includes(closed.company) || /closed|no longer|not (verified|open)/i.test(blockOf(s1.reply, closed.company)), `S1: ${closed.company}'s page is gone; it is not offered as open: ${blockOf(s1.reply, closed.company)}`);
  }, w);
  // The observed context at S2: the person's daily AI-answer allowance ran out on that turn (spec A.2). Spent here before S2.
  await w.sql(`insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) values ('${searcher}', 'America/Chicago', '{"on": false, "keywords": ["data analyst"]}'::jsonb, now()) on conflict (user_id) do update set tz = excluded.tz`).catch(() => "");
  await w.sql(`insert into public.career_digest_prefs (user_id, tz) values ('${searcher}', 'America/Chicago') on conflict (user_id) do update set tz = excluded.tz`).catch(() => "");
  await w.sql(`insert into public.agent_turn_costs (user_id, provider, models, calls, usd_micros) values ('${searcher}', 'anthropic', '{claude-sonnet-5-5}', 100, 60000)`);
  await w.sql(`update public.model_budget_days set spent_micros = limit_micros where day >= current_date - 1`);
  let s2: any = null;
  await c(t, FILE, 5, "S2 widens only role and place, keeps the verified S1 options, adds the new ones with their student requirements", async (ev: any) => {
    s2 = await turn(ev, S2.text, CHAT_B);
    notObserved("S2", s2.reply);
    for (const m of T.MARKET.filter((x: any) => x.s2)) ok(s2.reply.includes(m.company), `S2: ${m.company} (${m.title}) is in the widened list: ${s2.reply.slice(0, 700)}`);
    for (const m of T.MARKET.filter((x: any) => x.s1)) ok(s2.reply.includes(m.company), `S2: the earlier verified ${m.company} is kept`);
    ok(!/Toronto|Maplecrest/.test(s2.reply), "S2: remote US means US; a Canada-only role is not listed");
    const remote = T.MARKET.find((x: any) => /Remote/.test(x.location) && x.s2)!;
    ok(/graduat/i.test(blockOf(s2.reply, remote.company)), `S2: ${remote.company}'s graduation requirement is shown: ${blockOf(s2.reply, remote.company)}`);
    for (const m of T.MARKET.filter((x: any) => x.s2)) ok(blockOf(s2.reply, m.company).includes(m.url) || s2.buttons.some((x: any) => x.url === m.url), `S2: ${m.company}'s real link`);
    ok(listed(s2.reply).length >= 1, "S2: a numbered list");
    await noApplyFor(w, searcher, "S2");
  }, w);
  await c(t, FILE, 6, "S2 separates fit from eligibility: an unknown graduation date is named, never guessed into 'eligible'", async (ev: any) => {
    ok(s2, "S2 ran");
    ev.reply = s2.reply;
    const remote = T.MARKET.find((x: any) => /Remote/.test(x.location) && x.s2)!;
    const b = blockOf(s2.reply, remote.company);
    ok(b, `S2: ${remote.company} (remote US, with a graduation window) is listed, so its eligibility can be read: ${s2.reply.slice(0, 400)}`);
    ok(!/\byou (are|'re) eligible\b|\bmeets? (all|the) (hard )?requirements\b/i.test(b), `S2: eligibility is not asserted while the graduation date is unknown: ${b}`);
    ok(/graduation date|not (confirmed|on (file|your record))|can't (call|confirm)|unknown/i.test(s2.reply), `S2: names the unknown graduation date as the open eligibility fact: ${s2.reply.slice(0, 500)}`);
    const blocked = T.MARKET.find((x: any) => x.page === "blocked")!;
    if (s2.reply.includes(blocked.company)) ok(/couldn't (open|check)|limited|not verified|blocked/i.test(blockOf(s2.reply, blocked.company)), `S2: a page that refused the check is reported as a limited check: ${blockOf(s2.reply, blocked.company)}`);
  }, w);
  await c(t, FILE, 7, "S2 at the daily AI-answer limit: says what stopped, keeps the task, resets in the person's time (Chicago), no unrelated template", async (ev: any) => {
    ok(s2, "S2 ran");
    ev.reply = s2.reply;
    ok(!/midnight UTC/i.test(s2.reply), `S2: the reset is not in UTC: ${s2.reply.slice(-400)}`);
    ok(!/The window, checked against the record|2026-10-13/.test(s2.reply), "S2: no unrelated graduation-window template or old date");
    if (/limit/i.test(s2.reply)) {
      const reset = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
      const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: true }).format(reset); // e.g. "6 PM"
      const [h, ampm] = hour.split(" ");
      ok(new RegExp(`\\b${h}(:00)?\\s?${ampm}\\b`, "i").test(s2.reply) && /Chicago|Central|CT\b|CST|your time/i.test(s2.reply), `S2: the reset time in the person's zone (${hour} Chicago): ${s2.reply.slice(-400)}`);
      ok(s2.reply.search(/limit/i) < 400, "S2: the limit is said up front, not after unrelated text");
      ok(/search|list|internship/i.test(s2.reply.slice(Math.max(0, s2.reply.search(/limit/i) - 300), s2.reply.search(/limit/i) + 400)), "S2: says what stopped (the search) beside the limit");
      ok(/(haven't|have not|didn't|did not) appl|nothing (was )?(applied|sent)|not applied/i.test(s2.reply), "S2: says nothing was applied");
    }
  }, w);
  await c(t, FILE, 8, "the search replies are direct: no bare acknowledgement as the answer, no internal language, no repeated sentences", async (ev: any) => {
    for (const [id, s] of [["S1", s1], ["S2", s2]] as const) {
      ok(s, `${id} ran`);
      ev.reply += `${id}: ${s.reply}\n`;
      ok(internalHits(s.reply).length === 0, `${id}: internal language (${internalHits(s.reply).join(", ")})`);
      ok(repeated(s.reply).length === 0, `${id}: repeats itself: ${repeated(s.reply).join(" | ")}`);
      ok(!/^\s*(Tell me what you'd like to do next\.?)\s*$/im.test(s.bubbles.at(-1) ?? ""), `${id}: the last bubble is a generic prompt`);
      ok(s.bubbles.filter((b: string) => /^on it\b/i.test(b.trim())).length <= 1, `${id}: more than one progress bubble`);
    }
  }, w);

  // ------------------------------------------------------------------------------------------------ fix 15: the replay itself
  await check(t, FILE, 15, "both observed scenarios replayed with the same context meet every criterion; 2 scenarios, 5 user turns, counted honestly", async (ev: any) => {
    ev.turns = 5;
    ev.reply = `baseline ${T.BASELINE.scenarios} scenarios / ${T.BASELINE.turns} turns`;
    ok(T.BASELINE.scenarios === 2 && T.BASELINE.turns === 5, "the baseline is 2 scenarios and 5 user turns, not 1,000 tests");
    ok(t1 && t2 && s1 && s2, "every observed turn ran");
    ok(passed.every(Boolean), `${passed.filter((x) => !x).length} of the ${passed.length} replay checks above failed; fix 15 passes only when every observed turn meets its criteria`);
    ok(w.outbound.length === 0, `nothing left the machine: ${w.outbound.join(", ")}`);
    ok(w.bot.violations.length === 0, `every Telegram message valid: ${w.bot.violations.slice(0, 2).join(" | ")}`);
  }, w);
  // Screenshots of the File pages the replay's replies linked (the shortlist), at 390 px.
  await c(t, FILE, 5, "the shortlist's File page (if linked) opens on a phone at 390 px without sideways scroll", async (ev: any) => {
    const links = [...(s1?.links ?? []), ...(s2?.links ?? [])].filter((l: string) => l.startsWith(R.FILE_BASE));
    ok(links.length >= 1, `the shortlist reply links its File page: ${JSON.stringify([...(s1?.links ?? []), ...(s2?.links ?? [])])}`);
    for (const [i, l] of links.entries()) {
      const got = await w.open(l, CHAT_B);
      ok(got.status === 200 && got.html, `the File link opens (HTTP ${got.status})`);
      const r = await R.renderOpened(got, `observed-shortlist-${i}`);
      ev.screenshots.push(r.screenshot);
      ok(r.scrollWidth <= r.innerWidth, `no sideways scroll at 390 px (${r.scrollWidth})`);
      for (const m of T.MARKET.filter((x: any) => x.s1)) ok(r.text.includes(m.company), `the File page lists ${m.company}`);
    }
  }, w);
});

async function noApplyFor(w: any, person: string, label: string) {
  ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)) === "0", `${label}: "Don't apply yet" queued nothing`);
  ok((await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`)) === "0", `${label}: nothing approved`);
}
