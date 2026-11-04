// The Telegram chat flow end to end at scale (2026-10-30): a deterministic, seeded generator of what reaches Trainee's
// Telegram webhook (every update shape the Bot API sends, in any order, retried, forged) and of what the brain answers, each
// with what must happen. The product code is never consulted here: every expectation (who may be read, which chat a reply
// goes to, which domain a logo may come from, which tap approves what) comes from how the scenario was built.
//
//   webhook    the secret header right, missing, wrong, a prefix, a suffix, another case; another method; the webhook not
//              configured; a body that is no update. Wrong or missing: refused, and nothing processed.
//   order      2-8 updates from 1-3 chats, some delivered again (Telegram retries), in any order: each once, each reply to
//              the chat that asked.
//   update     edited messages, channel posts, stickers, voice, audio, video, photos, files, locations, polls, dice,
//              inline queries, member updates, group and supergroup messages, a bot's message, a tap in a group, a tap whose
//              message is gone, malformed updates; from a known person or a stranger. Never a crash; never silence where the
//              product answers; never a person's data in a group.
//   identity   sign-up open, closed, allow-listed by chat or by phone; a shared contact that is the sender's own, forwarded
//              (another user id), or without a user id; /stop with proactive messages queued, then /start; two chats.
//   cards      1-9 postings as the tools found them (names with emoji, "&", "<", 130 characters; links on the employer's own
//              careers host, an applicant-tracking host, a job board, LinkedIn / Indeed / Handshake, or ANOTHER company's
//              host that shares a prefix with the employer's name; a stated domain that is a job board), every field a
//              posting may or may not state (pay, level, posted in the past or the future, first seen, deadline, fit).
//   taps       Apply / Confirm / Details / Save / Edit / Cancel / Next, in any order, twice, after the payload changed, from
//              another person's chat, on a closed posting, a posting past its deadline, a never-automated host, a payload
//              that needs the person (a password field), a forged tag.
//   applyhere  "apply here <links>": LinkedIn, Indeed, Handshake on every host spelling, mixed with board links.
//   reply      what the brain answers: short, long (#301: head, then a page link or ONE second message), in parts, with
//              links, markdown, emoji, HTML-looking text; CAREER_TEXTING_NATIVE on and off.
//   ratelimit  Telegram answering 429 (retry_after 1-120 s) on a given message of a reply, once or twice.

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type R = ReturnType<typeof rng>;
export const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: R, p: number) => r() < p;
export const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const NOW = Date.parse("2026-10-30T15:00:00Z");
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ------------------------------------------------------------------------------------------------ webhook
export type SecretShape = "ok" | "missing" | "wrong" | "prefix" | "suffix" | "case" | "empty" | "other_bot";
export type Config = "ok" | "short_secret" | "no_secret" | "no_token";
export interface WebhookScenario { kind: "webhook"; id: number; category: string; secret: SecretShape; method: "POST" | "GET" | "PUT"; config: Config; body: "text" | "garbage" | "array" | "null" | "empty"; known: boolean }

// ------------------------------------------------------------------------------------------------ updates
export type UpdateShape =
  | "text" | "edited_message" | "edited_channel_post" | "channel_post" | "sticker" | "voice" | "audio" | "video" | "video_note" | "photo"
  | "document" | "location" | "poll" | "dice" | "inline_query" | "chosen_inline_result" | "member_kicked" | "member_back" | "chat_member"
  | "group_text" | "supergroup_text" | "group_start" | "bot_sender" | "group_tap" | "tap_no_message" | "no_update_id" | "string_update_id"
  | "empty_text" | "whitespace_text" | "caption_only_photo" | "negative_chat" | "huge_text" | "help" | "start";
export const UPDATE_SHAPES: UpdateShape[] = ["text", "edited_message", "edited_channel_post", "channel_post", "sticker", "voice", "audio", "video", "video_note", "photo",
  "document", "location", "poll", "dice", "inline_query", "chosen_inline_result", "member_kicked", "member_back", "chat_member", "group_text", "supergroup_text", "group_start",
  "bot_sender", "group_tap", "tap_no_message", "no_update_id", "string_update_id", "empty_text", "whitespace_text", "caption_only_photo", "negative_chat", "huge_text", "help", "start"];
export interface UpdateScenario { kind: "update"; id: number; category: string; shape: UpdateShape; known: boolean; signup: "open" | "closed"; chat: number }

export interface OrderScenario { kind: "order"; id: number; category: string; chats: number[]; updates: { updateId: number; chat: number; text: string }[]; deliveries: number[] }

// ------------------------------------------------------------------------------------------------ identity
export type IdStep =
  | { op: "text"; text: string }
  | { op: "contact"; whose: "own" | "forwarded" | "no_user_id" | "mismatch"; phone: string }
  | { op: "stop" | "start" | "help" | "stop_word" | "start_word" }
  | { op: "proactive"; key: string }
  | { op: "deliver" }
  | { op: "second_chat"; text: string };
export interface IdentityScenario {
  kind: "identity"; id: number; category: string; chat: number; signup: "open" | "closed" | "allow_chat" | "allow_phone" | "login_url"; allowPhone: string;
  otherAccountPhone: string | null; steps: IdStep[];
}

// ------------------------------------------------------------------------------------------------ cards
export type UrlKind = "own_careers" | "own_root" | "own_jobs" | "ats" | "board" | "never" | "decoy";
export interface Employer { company: string; domain: string | null; decoys: string[] }
// The employer's name, the domain that is truly theirs (null: none we could know), and hosts that belong to ANOTHER company
// whose name starts the same way (a logo from one of them is someone else's logo).
export const EMPLOYERS: Employer[] = [
  { company: "Acme", domain: "acme.com", decoys: [] },
  { company: "Acme Robotics", domain: "acmerobotics.com", decoys: [] },
  { company: "Meta", domain: "meta.com", decoys: ["metaview.ai", "metabase.com"] },
  { company: "Data Corp", domain: "datacorp.io", decoys: ["datadoghq.com", "databricks.com"] },
  { company: "Global Payments", domain: "globalpayments.com", decoys: ["globalstaffing.com", "globalrelay.com"] },
  { company: "United Airlines", domain: "united.com", decoys: ["unitedhealthgroup.com", "unitedrentals.com"] },
  { company: "Apple", domain: "apple.com", decoys: ["applebees.com", "appleone.com"] },
  { company: "Stripe, Inc.", domain: "stripe.com", decoys: ["stripes.com"] },
  { company: "Capital One", domain: "capitalone.com", decoys: ["capitalonearena.example"] },
  { company: "Halvorsen & Daughters", domain: "halvorsenanddaughters.com", decoys: [] },
  { company: "Café ☕ Collective", domain: null, decoys: [] },
  { company: "🚀 Rocket Labs", domain: null, decoys: ["rocketlawyer.com"] },
  { company: "R&D <Beta> Systems", domain: null, decoys: [] },
  { company: "Zürichwerk", domain: null, decoys: [] },
  { company: "Northwind Traders Corporation of the Greater Pacific Northwest Region and Associated Holdings International Limited", domain: null, decoys: [] },
];
const ATS = (slug: string, n: number) => [`https://boards.greenhouse.io/${slug}/jobs/${n}`, `https://jobs.lever.co/${slug}/${n}`, `https://jobs.ashbyhq.com/${slug}/${n}`, `https://${slug}.bamboohr.com/careers/${n}`, `https://${slug}.wd5.myworkdayjobs.com/en-US/External/job/${n}`];
const BOARDS = (n: number) => [`https://remoteok.com/remote-jobs/${n}`, `https://www.glassdoor.com/job-listing/${n}`, `https://www.ziprecruiter.com/c/x/Job/${n}`, `https://news.ycombinator.com/item?id=${n}`];
export const NEVER = (n: number) => [`https://www.linkedin.com/jobs/view/${n}`, `https://lnkd.in/j${n}`, `https://uk.indeed.com/viewjob?jk=${n}`, `https://www.indeed.com/viewjob?jk=${n}`,
  `https://app.joinhandshake.com/jobs/${n}`, `https://linkedin.com./jobs/view/${n}`, `https://ca.linkedin.com/jobs/view/${n}`, `https://joinhandshake.com/stu/jobs/${n}`];
export const slugOf = (company: string) => company.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "").slice(0, 30) || "employer";
const EMOJI_TITLES = ["🚀 Software Engineer", "Data Analyst 📊", "ML Engineer (LLMs) 🤖", "Designer 🎨🖌️", "Barista ☕"];
const TITLES = ["Data Analyst", "Software Engineer Intern", "Product Manager", "Senior Backend Engineer (Go)", "R&D Engineer <Senior>", "Analyst & Associate",
  "Ingénieur Logiciel", "データアナリスト", "Customer Success Manager — EMEA", ...EMOJI_TITLES];
const LOCATIONS = ["Austin, TX", "New York, NY", "Remote", "Zürich, Switzerland", "São Paulo", "London, UK", "", "東京"];
const REASONS = ["You list SQL and dashboards", "Your last role was analytics", "You said you want remote work", "Python is on your resume 🐍", "You led a team of 4 & shipped"];
const GAPS = ["No Tableau on file", "The posting asks for 5 years; you list 3", "A degree in CS is asked for", "German is asked for 🇩🇪"];

export interface PostingSpec {
  n: number; company: string; title: string; location: string; urlKind: UrlKind; url: string; jobId: string;
  statedDomain: string | null; // what the hit says the employer's domain is (may be a job board's: never the employer's)
  truthDomain: string | null; // the only domain a logo may come from
  pay: string | null; level: string | null; remote: "remote" | "hybrid" | "onsite" | null;
  postedAt: string | null; firstSeenAt: string | null; deadline: string | null; reasons: string[]; gaps: string[];
  closed: boolean; row: boolean; description: string | null;
}
const isoAt = (t: number) => new Date(t).toISOString();
function posting(r: R, n: number): PostingSpec {
  const e = pick(r, EMPLOYERS);
  const slug = slugOf(e.company);
  const urlKind: UrlKind = e.domain ? pick(r, ["own_careers", "own_root", "own_jobs", "ats", "ats", "board", "never", ...(e.decoys.length ? ["decoy", "decoy"] as const : [])])
    : pick(r, ["ats", "ats", "board", "never", ...(e.decoys.length ? ["decoy"] as const : [])]);
  const id = 4000000 + n * 7 + int(r, 0, 6);
  const url = urlKind === "own_careers" ? `https://careers.${e.domain}/jobs/${id}` : urlKind === "own_root" ? `https://www.${e.domain}/careers/${id}`
    : urlKind === "own_jobs" ? `https://jobs.${e.domain}/${id}` : urlKind === "ats" ? pick(r, ATS(slug, id)) : urlKind === "board" ? pick(r, BOARDS(id))
    : urlKind === "never" ? pick(r, NEVER(id)) : `https://careers.${pick(r, e.decoys)}/jobs/${id}`;
  const stated = chance(r, 0.25) ? pick(r, [e.domain, e.domain, "boards.greenhouse.io", "linkedin.com", "indeed.com", "lever.co", "not a domain", ...(e.domain ? [`https://www.${e.domain}/about`] : [])]) : null;
  const statedClean = stated ? stated.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase() : null;
  const truthDomain = statedClean && statedClean === e.domain ? e.domain : (urlKind.startsWith("own_") ? e.domain : null);
  const t = chance(r, 0.2) ? pick(r, EMOJI_TITLES) : pick(r, TITLES);
  const posted = chance(r, 0.6) ? (chance(r, 0.12) ? NOW + int(r, 2, 72) * HOUR : NOW - int(r, 1, 30 * 24 * 60) * MIN) : null;
  const deadline = chance(r, 0.3) ? (chance(r, 0.4) ? NOW - int(r, 1, 20) * DAY : NOW + int(r, 1, 40) * DAY) : null;
  const long = chance(r, 0.1);
  return {
    n, company: e.company, title: long ? `${t} ${"— a very long role title that goes on and on ".repeat(4)}`.trim() : t, location: pick(r, LOCATIONS), urlKind, url,
    jobId: urlKind === "ats" && url.includes("greenhouse") ? `greenhouse:${slug}:${id}` : urlKind === "ats" && url.includes("lever") ? `lever:${slug}:${id}` : `web:${slug}:${id}`,
    statedDomain: stated, truthDomain,
    pay: chance(r, 0.4) ? pick(r, ["$90k-$110k", "€55,000", "$25/hr", "Competitive", "₹12 LPA 💰"]) : null,
    level: chance(r, 0.4) ? pick(r, ["intern", "entry", "mid", "senior"]) : null,
    remote: chance(r, 0.5) ? pick(r, ["remote", "hybrid", "onsite"] as const) : null,
    postedAt: posted !== null ? isoAt(posted) : null, firstSeenAt: chance(r, 0.6) ? isoAt(NOW - int(r, 1, 600) * MIN) : null,
    deadline: deadline !== null ? isoAt(deadline) : null,
    reasons: Array.from({ length: int(r, 0, long ? 4 : 3) }, () => long ? `${pick(r, REASONS)} ${"and more detail ".repeat(8)}`.trim() : pick(r, REASONS)),
    gaps: Array.from({ length: int(r, 0, 2) }, () => long ? `${pick(r, GAPS)} ${"🚀".repeat(int(r, 20, 60))}` : pick(r, GAPS)),
    closed: chance(r, 0.12), row: chance(r, 0.9),
    description: chance(r, 0.7) ? `<p>About us</p><p>Requirements</p><ul><li>${pick(r, ["3 years of SQL", "Python & Go", "A <b>degree</b>", "German (C1)"])}</li><li>Dashboards</li></ul>` : null,
  };
}
export interface CardsScenario { kind: "cards"; id: number; category: string; postings: PostingSpec[]; feed: "none" | "url" | "webapp" | "both"; photoFails: boolean; logoGuess: boolean }

// ------------------------------------------------------------------------------------------------ taps
export type TapOp =
  | { op: "apply" | "details" | "save" | "edit" | "cancel" | "confirm" | "confirm_forged" | "confirm_stale_tag" }
  | { op: "change_payload" } | { op: "close_posting" } | { op: "prepare" } | { op: "other_person"; tap: "apply" | "confirm" | "details" }
  | { op: "next" } | { op: "retry_last" } | { op: "old_card" };
export interface TapsScenario {
  kind: "taps"; id: number; category: string; posting: PostingSpec; prepared: boolean; secretField: boolean; destinationNever: boolean; applied: boolean;
  pageCount: number; steps: TapOp[];
}

// ------------------------------------------------------------------------------------------------ apply here
export interface ApplyHereScenario { kind: "applyhere"; id: number; category: string; text: string; never: string[]; boards: string[]; prepared: boolean[]; feed: boolean }

// ------------------------------------------------------------------------------------------------ reply
export interface ReplyScenario {
  kind: "reply"; id: number; category: string; native: boolean; reply: string; urls: string[]; parts: string[] | null; more: string | null;
  links: string[]; secretsInError: boolean;
}

// ------------------------------------------------------------------------------------------------ 429
export interface RateScenario { kind: "ratelimit"; id: number; category: string; native: boolean; reply: string; failOn: number; retryAfter: number; times: number; viaMore: boolean }

export type Scenario = WebhookScenario | UpdateScenario | OrderScenario | IdentityScenario | CardsScenario | TapsScenario | ApplyHereScenario | ReplyScenario | RateScenario;

// ------------------------------------------------------------------------------------------------ text for replies
const WORDS = ["data", "analyst", "role", "Acme", "remote", "salary", "interview", "résumé", "Müller", "東京", "R&D", "C++", "<script>", "a<b", "x>y", "AT&T", "&amp;", "5 < 6",
  "**bold**", "_italic_", "`code`", "Python", "SQL", "next", "week", "🚀", "👩‍💻", "🇺🇸", "offer", "team", "hiring", "Friday", "#1", "100%"];
const sentence = (r: R) => { const n = int(r, 4, 16); const w = Array.from({ length: n }, () => pick(r, WORDS)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(" ")}${pick(r, [".", ".", "!", "?"])}`; };
const LINK_HOSTS = ["https://boards.greenhouse.io/acme/jobs/", "https://jobs.lever.co/globex/", "https://example.org/guide?x=1&y=", "https://en.wikipedia.org/wiki/Foo_(bar)_", "https://acme.com/careers/"];
const link = (r: R, i: number) => `${pick(r, LINK_HOSTS)}${4000 + i}`;
function replyText(r: R, size: "short" | "medium" | "long" | "huge"): { text: string; urls: string[] } {
  const target = size === "short" ? int(r, 20, 300) : size === "medium" ? int(r, 400, 1400) : size === "long" ? int(r, 1500, 3800) : int(r, 3801, 3990);
  const urls: string[] = [];
  let out = "";
  for (let i = 0; out.length < target; i++) {
    if (chance(r, 0.15)) { const u = link(r, urls.length); urls.push(u); out += `${out ? (chance(r, 0.5) ? "\n" : " ") : ""}${pick(r, ["", "See ", "Here: "])}${u}`; continue; }
    out += `${out ? (chance(r, 0.2) ? "\n\n" : " ") : ""}${sentence(r)}`;
  }
  // trim to the target on a sentence or a link, never inside one
  while (out.length > 3990) { const cut = out.lastIndexOf("\n"); out = cut > 0 ? out.slice(0, cut) : out.slice(0, 3990); }
  return { text: out, urls: urls.filter((u) => out.includes(u)) };
}

// ------------------------------------------------------------------------------------------------ generate
export function generate(o: { seed: number }): Scenario[] {
  const r = rng(o.seed);
  const out: Scenario[] = [];
  let id = 0;
  const push = (s: Omit<Scenario, "id">) => out.push({ ...(s as Scenario), id: ++id });
  // webhook: 900
  for (let i = 0; i < 900; i++) {
    const secret = pick(r, ["ok", "missing", "wrong", "prefix", "suffix", "case", "empty", "other_bot"] as const);
    const config = chance(r, 0.85) ? "ok" : pick(r, ["short_secret", "no_secret", "no_token"] as const);
    push({ kind: "webhook", category: `webhook/${secret}/${config}`, secret, method: chance(r, 0.9) ? "POST" : pick(r, ["GET", "PUT"] as const), config,
      body: chance(r, 0.8) ? "text" : pick(r, ["garbage", "array", "null", "empty"] as const), known: chance(r, 0.5) });
  }
  // order: 800
  for (let i = 0; i < 800; i++) {
    const chats = Array.from({ length: int(r, 1, 3) }, (_, k) => 810000 + i * 4 + k);
    const n = int(r, 2, 8);
    const updates = Array.from({ length: n }, (_, k) => ({ updateId: 50000 + i * 20 + k, chat: pick(r, chats), text: `m${k} ${sentence(r)}`.slice(0, 200) }));
    const deliveries: number[] = [];
    for (let k = 0; k < n; k++) { deliveries.push(k); if (chance(r, 0.3)) deliveries.push(k); }
    for (let k = deliveries.length - 1; k > 0; k--) { if (chance(r, 0.6)) { const j = int(r, 0, k); [deliveries[k], deliveries[j]] = [deliveries[j], deliveries[k]]; } }
    push({ kind: "order", category: `order/${chats.length}chats/${deliveries.length > n ? "retried" : "once"}`, chats, updates, deliveries });
  }
  // updates: 1700
  for (let i = 0; i < 1700; i++) {
    const shape = UPDATE_SHAPES[i % UPDATE_SHAPES.length];
    const known = chance(r, 0.6);
    push({ kind: "update", category: `update/${shape}/${known ? "known" : "stranger"}`, shape, known, signup: chance(r, 0.5) ? "open" : "closed", chat: 830000 + i });
  }
  // identity: 1500
  for (let i = 0; i < 1500; i++) {
    const chat = 850000 + i;
    const signup = pick(r, ["open", "closed", "allow_chat", "allow_phone", "login_url"] as const);
    const phone = `+1555${String(1000000 + i).slice(-7)}`;
    const steps: IdStep[] = [];
    const flavour = pick(r, ["contact", "stop", "two_chats", "mixed"] as const);
    if (flavour === "contact") {
      steps.push({ op: "contact", whose: pick(r, ["own", "own", "forwarded", "no_user_id", "mismatch"] as const), phone });
      if (chance(r, 0.5)) steps.push({ op: "text", text: "hi" });
      if (chance(r, 0.4)) steps.push({ op: "contact", whose: pick(r, ["own", "forwarded"] as const), phone });
    } else if (flavour === "stop") {
      steps.push({ op: "text", text: "hello" });
      for (let k = 0; k < int(r, 1, 3); k++) steps.push({ op: "proactive", key: `${pick(r, ["alert", "brief", "digest", "card", "status"])}:p${k}` });
      steps.push({ op: pick(r, ["stop", "stop", "stop_word"] as const) });
      if (chance(r, 0.5)) steps.push({ op: "deliver" });
      for (let k = 0; k < int(r, 0, 2); k++) steps.push({ op: "proactive", key: `${pick(r, ["alert", "digest"])}:q${k}` });
      steps.push({ op: "deliver" });
      if (chance(r, 0.6)) { steps.push({ op: pick(r, ["start", "start_word"] as const) }); steps.push({ op: "proactive", key: "alert:after" }); steps.push({ op: "deliver" }); }
    } else if (flavour === "two_chats") {
      steps.push({ op: "text", text: "hello" }, { op: "second_chat", text: "hi from my other chat" }, { op: "text", text: "what's next" });
    } else {
      for (let k = 0; k < int(r, 2, 5); k++) steps.push(pick(r, [{ op: "text", text: "find me jobs" }, { op: "help" }, { op: "start" }, { op: "contact", whose: "own", phone }, { op: "contact", whose: "forwarded", phone }] as IdStep[]));
    }
    push({ kind: "identity", category: `identity/${flavour}/${signup}`, chat, signup, allowPhone: phone, otherAccountPhone: chance(r, 0.2) ? phone : null, steps });
  }
  // cards: 2000
  let pn = 0;
  for (let i = 0; i < 2000; i++) {
    const n = chance(r, 0.6) ? int(r, 1, 3) : int(r, 4, 9);
    const postings = Array.from({ length: n }, () => posting(r, ++pn));
    push({ kind: "cards", category: `cards/${n <= 3 ? "few" : "many"}/${postings[0].urlKind}`, postings, feed: pick(r, ["none", "none", "url", "webapp", "both"] as const), photoFails: chance(r, 0.1), logoGuess: chance(r, 0.1) });
  }
  // taps: 1800
  for (let i = 0; i < 1800; i++) {
    const p = posting(r, ++pn);
    const steps: TapOp[] = [];
    const flavour = pick(r, ["confirm_twice", "changed", "other", "closed", "random", "random", "forged", "next"] as const);
    if (flavour === "confirm_twice") steps.push({ op: "apply" }, { op: "confirm" }, { op: "confirm" }, ...(chance(r, 0.5) ? [{ op: "retry_last" } as TapOp] : []));
    else if (flavour === "changed") steps.push({ op: "apply" }, { op: "change_payload" }, { op: "confirm" }, ...(chance(r, 0.5) ? [{ op: "apply" }, { op: "confirm" }] as TapOp[] : []));
    else if (flavour === "other") steps.push({ op: "apply" }, { op: "other_person", tap: pick(r, ["apply", "confirm", "details"] as const) }, ...(chance(r, 0.5) ? [{ op: "confirm" } as TapOp] : []));
    else if (flavour === "closed") steps.push({ op: "apply" }, { op: "close_posting" }, { op: "confirm" });
    else if (flavour === "forged") steps.push({ op: "apply" }, { op: pick(r, ["confirm_forged", "confirm_stale_tag"] as const) }, ...(chance(r, 0.5) ? [{ op: "confirm" } as TapOp] : []));
    else if (flavour === "next") steps.push({ op: "next" }, { op: "next" }, { op: "next" }, { op: "apply" });
    else for (let k = 0; k < int(r, 2, 7); k++) steps.push(pick(r, [{ op: "apply" }, { op: "details" }, { op: "save" }, { op: "edit" }, { op: "cancel" }, { op: "confirm" }, { op: "prepare" }, { op: "change_payload" }, { op: "old_card" }, { op: "retry_last" }] as TapOp[]));
    push({ kind: "taps", category: `taps/${flavour}/${p.urlKind === "never" ? "never" : p.closed ? "closed" : "open"}`, posting: p, prepared: chance(r, 0.75), secretField: chance(r, 0.1),
      destinationNever: chance(r, 0.05), applied: chance(r, 0.05), pageCount: flavour === "next" ? int(r, 6, 17) : 1, steps });
  }
  // apply here: 500
  for (let i = 0; i < 500; i++) {
    const never = Array.from({ length: int(r, 0, 3) }, (_, k) => pick(r, NEVER(5000000 + i * 10 + k)));
    const boards = Array.from({ length: int(r, never.length ? 0 : 1, 3) }, (_, k) => `https://boards.greenhouse.io/${pick(r, ["acme", "globex", "initech"])}/jobs/${6000000 + i * 10 + k}`);
    const links = [...never, ...boards].sort(() => (chance(r, 0.5) ? 1 : -1));
    const text = pick(r, [`apply here ${links.join(" ")}`, links.join("\n"), `please apply to ${links.join(", ")}`, `apply me to these: ${links.join(" ")}.`]);
    push({ kind: "applyhere", category: `applyhere/${never.length ? "never" : "boards"}/${boards.length}`, text, never, boards, prepared: boards.map(() => chance(r, 0.5)), feed: chance(r, 0.3) });
  }
  // reply: 1500
  for (let i = 0; i < 1500; i++) {
    const size = pick(r, ["short", "short", "medium", "long", "huge"] as const);
    const t = replyText(r, size);
    const shape = pick(r, ["plain", "plain", "parts", "more", "more"] as const);
    let parts: string[] | null = null, more: string | null = null;
    if (shape === "parts") parts = Array.from({ length: int(r, 2, 12) }, () => replyText(r, pick(r, ["short", "medium", "long", "huge"] as const)).text);
    if (shape === "more") more = Array.from({ length: int(r, 1, 40) }, () => sentence(r)).join(" ").slice(0, 3000).replace(/\s+\S*$/, ".");
    push({ kind: "reply", category: `reply/${shape}/${size}`, native: chance(r, 0.5), reply: shape === "more" ? replyText(r, "short").text.replace(/https?:\/\/\S+/g, "").trim() || "Short answer." : t.text,
      urls: shape === "more" ? [] : t.urls, parts, more, links: shape === "more" && chance(r, 0.4) ? [link(r, 90 + i)] : [], secretsInError: chance(r, 0.1) });
  }
  // 429: 600
  for (let i = 0; i < 600; i++) {
    const t = replyText(r, pick(r, ["short", "medium", "long", "huge"] as const));
    push({ kind: "ratelimit", category: `ratelimit/${i % 3 === 0 ? "first" : "later"}`, native: chance(r, 0.5), reply: t.text, failOn: i % 3 === 0 ? 0 : int(r, 0, 3),
      retryAfter: pick(r, [1, 2, 3, 5, 8, 10, 15, 30, 61, 120]), times: chance(r, 0.8) ? 1 : 2, viaMore: chance(r, 0.25) });
  }
  return out;
}
