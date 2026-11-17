// The code grader of the mass-apply conversation eval (rubric.json). Pure: it reads one scenario's Snapshot (what the runner
// recorded from the real handler and the stub worlds) and answers each code check yes or no with the evidence. Nothing here
// calls a model; the judge checks are judge.ts's. $0 and deterministic, so the grader has its own tests (grade.test.ts).
// deno-lint-ignore-file no-explicit-any

export interface Check { id: string; level: "MUST" | "NICE"; text: string; kind: "code" | "judge"; fn?: string; args?: Record<string, any>; turn?: number; question?: string }
export interface Scenario { id: string; title: string; setup: string[]; turns: string[]; oracle: Record<string, unknown>; ten: string; checks: Check[]; scale?: boolean }
export interface Posting { job_id: string; company: string; title: string; location: string; url: string; description: string }
// What one scenario left behind. `scripted[k]` is the index in `said`/`replies` of the scenario's k-th turn (the rest are the
// person's answers to questions Trainee asked); `postsAt`, `jobsAt` and `wallMs` are per scripted turn, after its background work.
export interface Snapshot {
  said: string[]; replies: string[]; intents: (string | null)[]; turnMs: number[]; scripted: number[];
  thread: { content: string; meta: any }[]; atsPosts: { board: string; job: string; files: { name: string; filename: string; sha256: string }[]; fields: Record<string, string>; confirmation_id: string }[];
  postsAt: number[]; jobsAt: number[]; wallMs: number[]; requested: string[];
  wanted: { company: string; title: string; url: string; posting_key: string }[];
  jobs: { company: string; url: string; job_id: string; payload_hash: string; approval_hash: string; payload_hash_now: string; state: string; confirmation_id: string | null; resume_name?: string | null }[];
  questions: { label: string; company: string | null; state: string; job_ids?: string[] }[];
}
export interface Result { id: string; level: "MUST" | "NICE"; pass: boolean | null; why: string }

const SUBMITTED = /^(submitted|submitted_unconfirmed|confirmed)$/;
const re = (s: string) => { const m = /^\(\?i\)/.test(s); return new RegExp(m ? s.slice(4) : s, m ? "i" : ""); };
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const replyAt = (x: Snapshot, k: number) => x.replies[x.scripted[k]] ?? "";
const ASKS = /(?:One question|Question \d+ of \d+) only you can answer|only you can answer/;
export const isCard = (m: { content: string; meta: any }) => m?.meta?.intent === "career_apply_card" || /^(?:\d+\/\d+\n)?\d+ applications? (?:is|are) ready\b/.test(String(m?.content ?? ""));

// The thread position of each scripted turn's reply (the thread holds replies and pushed messages in order).
function replyPositions(x: Snapshot): number[] {
  const pos: number[] = [];
  let from = 0;
  for (let i = 0; i < x.replies.length; i++) {
    const at = x.thread.findIndex((m, j) => j >= from && m.content === x.replies[i]);
    pos.push(at < 0 ? from : at);
    if (at >= 0) from = at + 1;
  }
  return pos;
}
// The cards shown before scripted turn k (each card: its messages, grouped by card id or consecutive pages).
export function cardsBefore(x: Snapshot, k: number): string[][] {
  const pos = replyPositions(x), end = k < x.scripted.length ? pos[x.scripted[k]] : x.thread.length;
  const cards: string[][] = [];
  let lastId: string | null = null, lastAt = -2;
  x.thread.forEach((m, j) => {
    if (j >= end || !isCard(m)) return;
    const id = m.meta?.card_id ?? null, paged = /^\d+\/\d+\n/.test(m.content);
    if (cards.length && ((id && id === lastId) || (paged && !/^1\//.test(m.content) && j === lastAt + 1))) cards[cards.length - 1].push(m.content);
    else cards.push([m.content]);
    lastId = id; lastAt = j;
  });
  return cards;
}
// The numbered items of a card (one block per "N. ..." line and the indented lines under it).
export function cardItems(card: string[]): { n: number; text: string }[] {
  const items: { n: number; text: string }[] = [];
  for (const line of card.join("\n").replace(/^\d+\/\d+$/gm, "").split("\n")) {
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (m) items.push({ n: Number(m[1]), text: m[2] });
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1].text += `\n${line.trim()}`;
  }
  return items;
}
const lastCard = (x: Snapshot, before: number) => { const c = cardsBefore(x, before); return c.length ? c[c.length - 1] : null; };
const yesTurn = (s: Scenario) => { const i = s.turns.findIndex((t) => /^yes\b/i.test(t.trim())); return i < 0 ? s.turns.length : i; };
const postingOf = (p: Posting[], company: string, text = "") => p.filter((q) => norm(q.company) === norm(company)).sort((a, b) => (norm(text).includes(norm(b.title)) ? 1 : 0) - (norm(text).includes(norm(a.title)) ? 1 : 0))[0] ?? null;
const wantedPosting = (p: Posting[], w: Snapshot["wanted"][number]) => p.find((q) => q.job_id === w.posting_key || q.url === w.url) ?? null;
// Words that make "confirmed" a negation or a description of what confirmation would be, not a claim.
const NOT_CONFIRMED = /\b(?:not|n't|never|no|neither|nor|none|un|yet to be|until|unless|when|once|if|whether|awaiting|waiting)\b[^.]{0,40}\bconfirm\w*|\bunconfirmed\b|\bconfirm\w* (?:by|from|in|with) (?:the )?(?:employer'?s? )?(?:email|mail)|\bconfirmation(?: id| number)?\b|\b(?:owner|you|person) confirmed\b|\bconfirmed (?:in chat|resume|facts?|by you)\b/gi;
const pc = (x: Snapshot) => x.atsPosts.map((p) => `${p.board}/${p.job}`);

type Fn = (x: Snapshot, a: Record<string, any>, s: Scenario, p: Posting[]) => [boolean, string];
export const FNS: Record<string, Fn> = {
  acted: (x, a) => {
    const intent = x.intents[x.scripted[a.turn]] ?? "", r = replyAt(x, a.turn);
    const ok = /apply|search|jobs/.test(intent) && !/\b(want me to|should I|shall I|would you like me to)\b[^.?]*\?\s*$/i.test(r.trim());
    return [ok && x.wanted.length > 0, `turn ${a.turn} handled as ${intent || "none"}; ${x.wanted.length} on the apply list`];
  },
  wanted_includes: (x, a) => { const have = new Set(x.wanted.map((w) => norm(w.company))), miss = a.companies.filter((c: string) => !have.has(norm(c))); return [!miss.length, miss.length ? `missing: ${miss.join(", ")}` : "all present"]; },
  wanted_excludes: (x, a) => { const bad = x.wanted.filter((w) => a.companies.some((c: string) => norm(c) === norm(w.company))); return [!bad.length, bad.length ? `on the list: ${bad.map((w) => `${w.company} ${w.title}`).join("; ")}` : "none of them"]; },
  wanted_titles: (x, a) => { const bad = x.wanted.filter((w) => !re(a.re).test(w.title)); return [x.wanted.length > 0 && !bad.length, bad.length ? `off-ask titles: ${bad.map((w) => w.title).join("; ")}` : `${x.wanted.length} all match`]; },
  wanted_locations: (x, a, _s, p) => { const bad = x.wanted.filter((w) => !re(a.re).test(wantedPosting(p, w)?.location ?? "")); return [x.wanted.length > 0 && !bad.length, bad.length ? `not matching: ${bad.map((w) => `${w.company} (${wantedPosting(p, w)?.location ?? "?"})`).join("; ")}` : `${x.wanted.length} all match`]; },
  wanted_count: (x, a) => { const n = x.wanted.length; return [(a.min == null || n >= a.min) && (a.max == null || n <= a.max) && (a.eq == null || n === a.eq), `${n} on the apply list`]; },
  reply_matches: (x, a) => { const r = replyAt(x, a.turn); return [re(a.re).test(r), `turn ${a.turn}: "${r.slice(0, 160).replace(/\n/g, " ")}"`]; },
  reply_matches_all: (x, a) => { const r = replyAt(x, a.turn), miss = a.res.filter((q: string) => !re(q).test(r)); return [!miss.length, miss.length ? `missing ${miss.join(", ")}` : "all named"]; },
  reply_not: (x, a) => { const r = replyAt(x, a.turn), m = re(a.re).exec(r); return [!m, m ? `says "${m[0]}"` : "clean"]; },
  thread_matches: (x, a) => { const all = [...x.thread.map((m) => m.content), ...x.replies]; const hit = all.find((t) => re(a.re).test(t)); return [!!hit, hit ? `"${hit.slice(0, 120).replace(/\n/g, " ")}"` : "not said anywhere"]; },
  questions_max: (x, a) => { const n = (replyAt(x, a.turn).match(/\?/g) ?? []).length; return [n <= a.max, `${n} question mark(s)`]; },
  nothing_approved: (x) => [x.jobs.length === 0 && x.atsPosts.length === 0, `${x.jobs.length} approved, ${x.atsPosts.length} sent`],
  nothing_before: (x, a) => {
    const k = a.turn - 1, posts = k >= 0 ? x.postsAt[k] ?? 0 : 0, jobs = k >= 0 ? x.jobsAt[k] ?? 0 : 0;
    return [posts === 0 && jobs === 0, `after turn ${k}: ${jobs} approved, ${posts} reached an employer`];
  },
  card_shown: (x, a) => {
    const c = lastCard(x, a.before);
    if (!c) return [false, `no card before turn ${a.before}`];
    const n = cardItems(c).length;
    return [a.items == null ? n > 0 : n === a.items, `card of ${n} item(s) in ${c.length} message(s)`];
  },
  card_fields: (x, a, s, p) => {
    const c = lastCard(x, yesTurn(s));
    if (!c) return [false, "no card"];
    const items = cardItems(c), miss: string[] = [];
    for (const it of items) {
      const head = it.text.split("\n")[0], co = /^(.+?)(?: — | - |: )/.exec(head)?.[1] ?? head, post = postingOf(p, co, it.text);
      for (const f of a.fields) {
        const ok = f === "employer" ? !!post || /\S/.test(co)
          : f === "role" ? (post ? norm(it.text).includes(norm(post.title)) : / — /.test(head))
          : f === "link" ? /https?:\/\/\S+/.test(it.text)
          : f === "fit" ? /\b(fit|fits|match(es)?|because|why|your (?:\w+ ){0,3}(experience|project|skills?))\b/i.test(it.text)
          : f === "resume" ? /\b(resume|cv)\b|\.pdf\b/i.test(it.text)
          : false;
        if (!ok) miss.push(`#${it.n} ${f}`);
      }
    }
    return [items.length > 0 && !miss.length, miss.length ? `missing ${miss.slice(0, 8).join(", ")}${miss.length > 8 ? ` and ${miss.length - 8} more` : ""}` : `${items.length} item(s) carry ${a.fields.join(", ")}`];
  },
  card_posted_terms: (x, _a, s, p) => {
    const c = lastCard(x, yesTurn(s));
    if (!c) return [false, "no card"];
    const miss: string[] = [];
    let any = 0;
    for (const it of cardItems(c)) {
      const co = /^(.+?)(?: — | - |: )/.exec(it.text)?.[1] ?? it.text, post = postingOf(p, co, it.text);
      if (!post) continue;
      const pay = /(?:Pay|Salary): ([^.]*\d[^.]*)\./.exec(post.description)?.[1], due = /(?:Apply by|Applications close) ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(post.description)?.[1];
      if (pay) { any++; if (!it.text.includes(pay.split(/[-–]/)[0].trim())) miss.push(`#${it.n} pay`); }
      if (due) { any++; if (!it.text.includes(due.split(",")[0])) miss.push(`#${it.n} deadline`); }
    }
    return [!miss.length, any ? (miss.length ? `missing ${miss.join(", ")}` : `${any} posted term(s) shown`) : "no posting on the card states pay or a deadline"];
  },
  card_open_named: (x, _a, s) => {
    const open = x.questions.filter((q) => q.state === "open");
    if (!open.length) return [true, "no question open"];
    const c = lastCard(x, yesTurn(s));
    return [!!c && /Needs you/i.test(c.join("\n")), `${open.length} open question(s)`];
  },
  card_messages_fit: (x, a, s) => { const c = lastCard(x, yesTurn(s)); if (!c) return [false, "no card"]; const big = c.filter((m) => m.length > a.max); return [!big.length, `${c.length} message(s), longest ${Math.max(...c.map((m) => m.length))} characters`]; },
  card_summary: (x, a, s) => { const c = lastCard(x, yesTurn(s)); if (!c) return [false, "no card"]; const link = c.some((m) => /https:\/\/file\.[^\s]+/.test(m)); return [c.length <= a.max_messages && link, `${c.length} message(s), ${link ? "with" : "without"} a File link`]; },
  approved: (x, a) => [x.jobs.length === a.eq, `${x.jobs.length} approved`],
  approved_companies: (x, a) => { const got = [...new Set(x.jobs.map((j) => norm(j.company)))].sort(), want = a.eq.map(norm).sort(); return [JSON.stringify(got) === JSON.stringify(want), `approved: ${x.jobs.map((j) => j.company).join(", ") || "none"}`]; },
  approved_includes: (x, a) => { const have = new Set(x.jobs.map((j) => norm(j.company))), miss = a.companies.filter((c: string) => !have.has(norm(c))); return [!miss.length, miss.length ? `not approved: ${miss.join(", ")}` : "approved"]; },
  approved_excludes_host: (x, a) => { const bad = x.jobs.filter((j) => re(a.re).test(String(j.url))); return [!bad.length, bad.length ? `${bad.length} approved` : "none approved"]; },
  approved_card_items: (x, a, s) => {
    const c = lastCard(x, yesTurn(s) < s.turns.length ? yesTurn(s) : s.turns.length - 1);
    if (!c) return [false, "no card"];
    const items = cardItems(c), want = a.items.map((n: number) => items.find((i) => i.n === n)?.text.split(/ — | - |\n/)[0] ?? `#${n}`).map(norm).sort();
    const got = x.jobs.map((j) => norm(j.company)).sort();
    return [JSON.stringify(got) === JSON.stringify(want), `card items ${a.items.join(",")} = ${want.join(", ")}; approved ${got.join(", ") || "none"}`];
  },
  hash_bound: (x) => { const bad = x.jobs.filter((j) => !j.approval_hash || j.approval_hash !== j.payload_hash || j.payload_hash !== j.payload_hash_now); return [x.jobs.length > 0 && !bad.length, `${x.jobs.length - bad.length}/${x.jobs.length} bound`]; },
  exactly_once: (x) => {
    const keys = pc(x), dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    const ids = x.jobs.map((j) => j.job_id), dupJobs = ids.filter((k, i) => ids.indexOf(k) !== i);
    const sent = x.jobs.filter((j) => SUBMITTED.test(j.state)).length;
    return [x.jobs.length > 0 && !dup.length && !dupJobs.length && sent === x.jobs.length && keys.length === x.jobs.length,
      `${x.jobs.length} approved, ${sent} recorded sent, ${keys.length} posts${dup.length ? `, sent twice: ${dup.join(", ")}` : ""}${dupJobs.length ? `, enqueued twice: ${dupJobs.join(", ")}` : ""}`];
  },
  resume_attached: (x) => { const bad = x.atsPosts.filter((p) => !p.files.some((f) => f.name === "resume")); return [x.atsPosts.length > 0 && !bad.length, `${x.atsPosts.length - bad.length}/${x.atsPosts.length} with a resume`]; },
  reply_count: (x, a) => { const n = x.jobs.length, r = replyAt(x, a.turn); return [n > 0 && new RegExp(`\\b${n}\\b`).test(r), `${n} approved; reply: "${r.slice(0, 120).replace(/\n/g, " ")}"`]; },
  never_asked: (x, a) => {
    const rows = x.questions.filter((q) => re(a.re).test(q.label));
    const asked = x.thread.filter((m) => ASKS.test(m.content) && re(a.re).test(m.content.split("\n").slice(1, 3).join(" ")));
    return [!rows.length && !asked.length, rows.length || asked.length ? `asked: ${[...new Set(rows.map((q) => q.label))].join("; ")}` : "never asked"];
  },
  asked_once: (x) => {
    const labels = x.questions.map((q) => norm(q.label)), dup = labels.filter((l, i) => labels.indexOf(l) !== i);
    return [!dup.length, dup.length ? `asked more than once: ${[...new Set(dup)].join("; ")}` : `${labels.length} question(s), each once`];
  },
  answer_turns: (x, a) => { const n = x.said.length - x.scripted.length; return [n <= a.max, `${n} answer turn(s)`]; },
  status_counts: (x, a) => {
    const n = x.jobs.filter((j) => SUBMITTED.test(j.state)).length, r = replyAt(x, a.turn);
    const words = ["zero", "one", "two", "three", "four", "five"], ok = new RegExp(`\\b(${n}|${words[n] ?? n})\\b`, "i").test(r) || (n === 2 && /\bboth\b/i.test(r)) || (n > 0 && x.jobs.every((j) => r.toLowerCase().includes(norm(j.company))));
    return [ok, `${n} sent; reply: "${r.slice(0, 160).replace(/\n/g, " ")}"`];
  },
  no_false_confirmed: (x, a) => {
    if (x.jobs.some((j) => j.state === "confirmed")) return [true, "an employer confirmed one"];
    const r = replyAt(x, a.turn).replace(NOT_CONFIRMED, ""), m = /\bconfirmed\b/i.exec(r);
    return [!m, m ? `says confirmed: "${r.slice(Math.max(0, m.index - 60), m.index + 20)}"` : "never claims confirmed"];
  },
  no_request: (x, a) => { const hit = x.requested.filter((h) => re(a.re).test(h)); return [!hit.length, hit.length ? `${hit.length} request(s)` : "none"]; },
  turn_ms: (x, a) => { const m = Math.max(0, ...x.turnMs); return [m <= a.max, `slowest turn ${(m / 1000).toFixed(1)} s`]; },
  prep_ms: (x, a) => { const m = x.wallMs[0] ?? Infinity; return [m <= a.max, `ask to card ${(m / 1000).toFixed(1)} s`]; },
  proof_said: (x, _a, s) => {
    const pos = replyPositions(x), from = pos[x.scripted[yesTurn(s)]] ?? x.thread.length;
    const after = [...x.thread.slice(from).map((m) => m.content)];
    const hit = after.find((t) => /\b(submitted|sent)\b/i.test(t) && (/[A-Z]{2}-[a-z0-9]+-\d+-\d+/.test(t) || /unconfirmed|not (yet )?confirmed|confirmation/i.test(t)));
    return [!!hit, hit ? `"${hit.slice(0, 120).replace(/\n/g, " ")}"` : `nothing after the yes says what was sent with its proof (${after.length} message(s))`];
  },
};

export function gradeCode(s: Scenario, x: Snapshot, postings: Posting[]): Result[] {
  return s.checks.filter((c) => c.kind === "code").map((c) => {
    const f = FNS[c.fn ?? ""];
    if (!f) return { id: c.id, level: c.level, pass: false, why: `no check named ${c.fn}` };
    try { const [pass, why] = f(x, c.args ?? {}, s, postings); return { id: c.id, level: c.level, pass, why }; } catch (e) { return { id: c.id, level: c.level, pass: false, why: `check threw: ${(e as Error).message}` }; }
  });
}

// The rubric's score: 10 x MUSTs met / MUSTs, capped at 8 unless at least half the NICEs are met. A check not graded (null: a
// judge check in a run without the judge) is left out of both counts and reported.
export function score(rs: Result[]): { score: number; must: string; nice: string; ungraded: number } {
  const g = rs.filter((r) => r.pass !== null), M = g.filter((r) => r.level === "MUST"), N = g.filter((r) => r.level === "NICE");
  const m = M.filter((r) => r.pass).length, n = N.filter((r) => r.pass).length;
  let sc = M.length ? (10 * m) / M.length : 10;
  if (N.length && n < N.length / 2) sc = Math.min(sc, 8);
  return { score: Math.round(sc * 10) / 10, must: `${m}/${M.length}`, nice: `${n}/${N.length}`, ungraded: rs.length - g.length };
}
