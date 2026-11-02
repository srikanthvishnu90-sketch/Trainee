// PEOPLE FINDING and INTRODUCTIONS (D-033, owner 2026-10-26: "start with value for one user: find relevant people,
// prepare outreach they approve, and help request introductions through their existing contacts").
//
// Code-first, inside the networking turn (career_networking.ts networkingTurn calls peopleTurn first), so it runs on the
// live path on every channel. What it does, all from the person's OWN sources (never LinkedIn or Indeed automation, never
// a people database, never a guessed name, title or address):
//   import     their LinkedIn data export (Connections.csv or the ZIP), sent as a file or pasted (in parts if long);
//              kept per person in career_people; the confirmation is one line with the database's counts.
//   who        "who do I know at Ramp": their export, their Gmail correspondents at ramp.com (gmail.readonly headers),
//              people a public page they sent publishes, and the lists they sent earlier; or, with nothing on file,
//              the one ask for the export (why and how, three steps), asked once and pointed back to after.
//   alumni     "DePaul alumni at Stripe": contacts at that firm whose school is on file (the export has no school
//              column, which the reply says), against the school they name or their confirmed education.
//   page       a company's team page or someone's own site they send: names published as schema.org Person, addresses
//              published as mailto links, the source URL kept (career_people_page.ts). Trainee has no web search.
//   jobs       postings from their Handshake and Indeed alert emails (career_people_gmail.ts), each with its link.
//   intro      "get me an intro to Maya Chen at Ramp": a path (a direct contact, else a mutual at the same firm or
//              school, else a route the target publishes), a short forwardable request drafted from confirmed facts
//              (career_outreach.ts draftFor and its fact-lock), approved by its exact text, delivered by the person
//              (copy-ready text, or a mailto link): Trainee never sends and never contacts anyone itself. Tracked
//              (sent, replied, no reply: the person's word or Gmail's), with a reminder only when they ask for one:
//              pushed by the scheduled run when CAREER_INTRO_REMINDERS is on (career_people_reminders.ts), and in
//              any case shown at their next message if it has not been pushed by then.
//   forget     "forget my LinkedIn contacts" (and Gmail contacts, job emails, intro requests): deleted and read back.
import { contactsOf, type ContactRow, MX_NOT_WIRED, normalizeFirm, verifyRows } from "./career_contacts.ts";
import { confirmed, draftFor, factText, type ModelFn, type OutreachStore, type Recipient } from "./career_outreach.ts";
import { FACTS_INTENT, parseNetworkingAsk, personKey, setFactAsk } from "./career_networking.ts";
import { factQuestion } from "./career_outreach_personalize.ts";
import { CAREER_READ_SCOPE, careerTokenFor } from "./career_mail_gmail.ts";
import { connectUrl } from "./agent/integrations.ts";
import { chatAsk, cleanCell, companyKey, parseCsv, parseExport, type ParsedExport, peopleFileText, type PersonRow, sha256Hex } from "./career_people_import.ts";
import { domainLabelOf, type GmailRead, heardFrom, isCompanyLabel, registrable } from "./career_people_gmail.ts";
import { firmDomains } from "./career_outreach_personalize.ts";
import { memorySweepStore, type SweepOutcome, type SweepSink, type SweepStore, supabaseSweepStore, sweepTurn } from "./career_people_sweep.ts";
import { checkUrl, formerTitle, type PageGet, pinnedGet, readPage, type Resolver } from "./career_people_page.ts";
import { findTargets, makeProvider, parseTargetAsk, providerConfig, supabaseProviderStore, type TargetAsk, type TargetDeps } from "./career_people_provider.ts";

export const IMPORT_INTENT = "career_contacts_import", AT_INTENT = "career_contacts_at", ALUMNI_INTENT = "career_people_alumni";
export const PAGE_INTENT = "career_people_page", JOBS_INTENT = "career_job_emails", FORGET_INTENT = "career_people_forget";
export const INTRO_INTENT = "career_intro_request", INTRO_UPDATE_INTENT = "career_intro_update", INTRO_LIST_INTENT = "career_intro_list";
export const SCHOOL_INTENT = "career_people_school", TARGETS_INTENT = "career_people_targets";
export const MIRROR_MAX = 1000;     // a convenience copy in the thread (snapshot at most 1 MB); the drafter also reads career_people, so no one is out of reach
export const PASTE_WINDOW_MS = 60 * 60_000;
export const LIST_MAX = 15;
// One read page: how many rows a turn reads from one table at once (an indexed, bounded read). Not a volume limit: the
// scheduled push pages through every row, imports go in parts of IMPORT_PART with no total cap, and counts are the database's.
export const PAGE = 200, IMPORT_PART = 2000;
export const LINKEDIN_FILE = "Connections.csv";
export const NO_FINDER = "I don't have a people database or an email finder, and I won't guess names or addresses.";
export const NO_SEARCH = "I can't search the web, so I don't look up a company's pages myself.";
export const PASTE_HOW = "Attaching a file isn't available in this chat yet, so open the file, copy everything and paste it here; about 40 rows fit in one message (fewer by text message), so send a long file in parts, the header line first.";
// The one ask, with why and how (LinkedIn's help page "Export connections from LinkedIn", a566336, via enrow.io).
export const EXPORT_STEPS = `I find people through your own network, and LinkedIn only lets you download it (I never open LinkedIn for you): 1) on LinkedIn: Me, Settings & Privacy, Data privacy, Get a copy of your data, Connections, Request archive; 2) open the download link LinkedIn emails you (the link lasts 72 hours) and save the file; 3) send me Connections.csv here. ${PASTE_HOW}`;
export const EXPORT_AGAIN = `Send me your LinkedIn Connections.csv (the steps are in my earlier message: LinkedIn, Settings & Privacy, Data privacy, Get a copy of your data, Connections). ${PASTE_HOW}`;

export type Source = "linkedin_export" | "gmail" | "company_page" | "provider";
export type SourceKind = "own_export" | "own_gmail" | "company_page" | "person_typed";
export interface PersonRec {
  id: number | null; source: Source | "thread_list"; name: string | null; email: string | null; company: string; company_key: string;
  position: string; school: string; connected_on: string | null; last_seen_at: string | null; source_ref: string; source_url: string | null; retrieved_at: string;
  // A discovered person (source "provider"): how their address was found (published / inferred / bounced / none) and whether
  // it may be written to (an address, its domain's mail server found, never bounced). Absent on the person's own rows.
  email_status?: string | null; sendable?: boolean;
}
export const kindOf = (s: PersonRec["source"]): SourceKind => s === "gmail" ? "own_gmail" : s === "company_page" ? "company_page" : "own_export";
export interface Intro {
  id: number; n: number; route: "mutual" | "direct"; target_name: string; target_company: string; target_title: string; target_ref: string;
  via_name: string | null; via_ref: string | null; to_name: string; to_email: string | null; delivery: "mailto" | "copy";
  subject: string; body: string; blurb: string | null; payload_hash: string; status: string; status_source: string | null;
  approved_hash: string | null; approved_at: string | null; sent_at: string | null; follow_up_days: number | null; follow_up_at: string | null;
  reminded_at: string | null; created_at: string;
}
export interface Prefs { export_asked_at: string | null; paste_header: string | null; paste_file: string | null; paste_at: string | null }

// ------------------------------------------------------------------------------------------------ the store
export interface PeopleStore {
  importRows(userId: string, source: Source, file: string, sha: string | null, rows: Record<string, unknown>[], read: number, skipped: number, replace: boolean):
    Promise<{ inserted: number; duplicates: number; kept: number; with_email: number; replaced: number }>;
  counts(userId: string): Promise<Partial<Record<Source, number>>>;
  atCompany(userId: string, key: string): Promise<PersonRec[]>; // one page (PAGE), those with an address first
  // Counts in the database, so a reply's number is true however many rows there are (absent: counted from a page).
  tallies?(userId: string, companyKey: string): Promise<{ intros_open: number; at_company: number }>;
  // This person's due reminders (the in-chat line), on the partial due index (absent: filtered from intros()).
  dueFor?(userId: string, nowIso: string): Promise<Intro[]>;
  named(userId: string, name: string): Promise<PersonRec[]>;
  setSchool(userId: string, ids: number[], school: string): Promise<number>;
  forget(userId: string, sources: Source[]): Promise<number>;
  prefs(userId: string): Promise<Prefs>;
  setPrefs(userId: string, p: Partial<Prefs>): Promise<void>;
  saveJobs(userId: string, jobs: { source: string; title: string; detail: string; url: string; message_hash: string; received_at: string }[]): Promise<number>;
  jobs(userId: string, limit: number): Promise<{ source: string; title: string; detail: string; url: string; received_at: string }[]>;
  forgetJobs(userId: string): Promise<number>;
  intros(userId: string): Promise<Intro[]>;
  intro(userId: string, n: number): Promise<Intro | null>;
  // Every intro whose asked-for reminder is due (armed, unreminded, still approved or sent), oldest due first, across
  // people: the scheduled push's read (career_people_reminders.ts). Mirrors dueLine's filter below exactly.
  dueIntros(nowIso: string): Promise<{ userId: string; intro: Intro }[]>;
  addIntro(userId: string, i: Omit<Intro, "id" | "n" | "status" | "status_source" | "approved_hash" | "approved_at" | "sent_at" | "follow_up_days" | "follow_up_at" | "reminded_at" | "created_at">): Promise<Intro>;
  updateIntro(userId: string, n: number, patch: Partial<Intro>, onlyIf?: { status?: string[]; payload_hash?: string }): Promise<Intro | null>;
  forgetIntros(userId: string): Promise<number>;
  // The drafter's copy of contacts lives in each thread's state (state.career.stores.contacts). A forget is the
  // account's: drop the export's rows (all rows when `all`) from every OTHER thread of this person (the turn's own thread
  // is its working state, cleared by the turn and saved with it). A row is the export's when it says linkedin_export or
  // came from a Connections.csv file (fromExport below; the SQL function uses the same rule). Returns the rows removed and
  // the threads they were in.
  pruneThreadContacts(userId: string, exceptThread: string, all: boolean): Promise<{ rows: number; threads: number }>;
}
// deno-lint-ignore no-explicit-any
const must = (r: { data: any; error: any }, what: string): any => { if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r.data; };
const COLS = "id,source,name,email,company,company_key,position,school,connected_on,last_seen_at,source_ref,source_url,retrieved_at,email_status,sendable";
// deno-lint-ignore no-explicit-any
export function supabasePeopleStore(admin: any): PeopleStore {
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  return {
    // In parts of IMPORT_PART rows (one request and one statement each), all under one import record, so an export of
    // tens of thousands of rows never travels or locks as one piece; the result is the database's totals after the last part.
    async importRows(userId, source, file, sha, rows, read, skipped, replace) {
      let imp: number | null = null, inserted = 0, duplicates = 0, replaced = 0, last: any = null;
      for (let i = 0; i === 0 || i < rows.length; i += IMPORT_PART) {
        last = must(await admin.rpc("career_people_import_part", { p_user: userId, p_source: source, p_file: file, p_sha: sha, p_rows: rows.slice(i, i + IMPORT_PART),
          p_read: read, p_skipped: skipped, p_replace: replace, p_import: imp }), "save the people");
        imp = Number(last.import); inserted += Number(last.inserted); duplicates += Number(last.duplicates); replaced += Number(last.replaced ?? 0);
      }
      return { inserted, duplicates, kept: Number(last.kept), with_email: Number(last.with_email), replaced };
    },
    async counts(userId) { return must(await admin.rpc("career_people_counts", { p_user: userId }), "count the people") ?? {}; },
    // One page at a company (career_people_company index), those with an address first; the true total is tallies().
    async atCompany(userId, key) {
      if (!key) return [];
      return must(await admin.from("career_people").select(COLS).eq("user_id", userId).eq("company_key", key).order("email", { ascending: true, nullsFirst: false }).order("id", { ascending: true }).limit(PAGE), "read the people at a company") ?? [];
    },
    async tallies(userId, key) {
      const r = must(await admin.rpc("career_people_tallies", { p_user: userId, p_company_key: key }), "count the people");
      return { intros_open: Number(r?.intros_open ?? 0), at_company: Number(r?.at_company ?? 0) };
    },
    async dueFor(userId, nowIso) {
      return must(await admin.from("career_intro_requests").select("*").eq("user_id", userId).not("follow_up_at", "is", null).is("reminded_at", null)
        .in("status", ["approved", "sent"]).lte("follow_up_at", nowIso).order("follow_up_at", { ascending: true }).limit(PAGE), "read the due intro reminders") ?? [];
    },
    // On the (user_id, lower(name)) index: an exact name, else a first name alone; one page, exact matches first.
    async named(userId, name) {
      const n = cleanCell(name, 200);
      if (!n) return [];
      const rows = must(await admin.rpc("career_people_named", { p_user: userId, p_name: n, p_limit: PAGE }), "read the people by name") ?? [];
      const exact = rows.filter((r: PersonRec) => (r.name ?? "").toLowerCase() === n.toLowerCase());
      return exact.length || /\s/.test(n) ? exact : rows;
    },
    async setSchool(userId, ids, school) {
      if (!ids.length) return 0;
      return (must(await admin.from("career_people").update({ school }).eq("user_id", userId).in("id", ids).select("id"), "save the school") ?? []).length;
    },
    async forget(userId, sources) {
      const gone = must(await admin.from("career_people").delete().eq("user_id", userId).in("source", sources).select("id"), "forget the people") ?? [];
      must(await admin.from("career_people_imports").delete().eq("user_id", userId).in("source", sources).select("id"), "forget the imports");
      if (sources.includes("linkedin_export")) must(await admin.from("career_people_prefs").update({ paste_header: null, paste_file: null, paste_at: null }).eq("user_id", userId).select("user_id"), "forget the paste");
      const left = must(await admin.from("career_people").select("id").eq("user_id", userId).in("source", sources).limit(1), "read back the people") ?? [];
      if (left.length) throw new Error("forget the people: rows remain after the delete");
      return gone.length;
    },
    async prefs(userId) {
      const r = must(await admin.from("career_people_prefs").select("export_asked_at,paste_header,paste_file,paste_at").eq("user_id", userId).maybeSingle(), "read the people settings");
      return r ?? { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null };
    },
    async setPrefs(userId, p) {
      must(await admin.from("career_people_prefs").upsert({ user_id: userId, ...p, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select("user_id"), "save the people settings");
    },
    async saveJobs(userId, jobs) {
      if (!jobs.length) return 0;
      const r = must(await admin.from("career_job_emails").upsert(jobs.map((j) => ({ user_id: userId, ...j })), { onConflict: "user_id,url", ignoreDuplicates: true }).select("id"), "save the job emails") ?? [];
      return r.length;
    },
    async jobs(userId, limit) {
      return must(await admin.from("career_job_emails").select("source,title,detail,url,received_at").eq("user_id", userId).order("received_at", { ascending: false }).limit(limit), "read the job emails") ?? [];
    },
    async forgetJobs(userId) { return (must(await admin.from("career_job_emails").delete().eq("user_id", userId).select("id"), "forget the job emails") ?? []).length; },
    // The most recent page of intro requests (newest PAGE by number), returned oldest first.
    async intros(userId) { return ((must(await admin.from("career_intro_requests").select("*").eq("user_id", userId).order("n", { ascending: false }).limit(PAGE), "read the intro requests") ?? []) as Intro[]).reverse(); },
    // Every due reminder, however many: keyset pages of PAGE on the partial due index (no cap of Trainee's own).
    async dueIntros(nowIso) {
      // deno-lint-ignore no-explicit-any
      const out: { userId: string; intro: Intro }[] = [];
      let afterAt: string | null = null, afterId: number | null = null;
      for (;;) {
        // deno-lint-ignore no-explicit-any
        const rows: any[] = must(await admin.rpc("career_intro_due", { p_now: nowIso, p_after_at: afterAt, p_after_id: afterId, p_limit: PAGE }), "read the due intro reminders") ?? [];
        for (const r of rows) { const { user_id, ...intro } = r; out.push({ userId: String(user_id), intro: intro as Intro }); }
        if (rows.length < PAGE) return out;
        afterAt = rows.at(-1).follow_up_at; afterId = rows.at(-1).id;
      }
    },
    async intro(userId, n) { return must(await admin.from("career_intro_requests").select("*").eq("user_id", userId).eq("n", n).maybeSingle(), "read the intro request"); },
    async addIntro(userId, i) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const top = must(await admin.from("career_intro_requests").select("n").eq("user_id", userId).order("n", { ascending: false }).limit(1), "number the intro request") ?? [];
        const n = (top[0]?.n ?? 0) + 1;
        const r = await admin.from("career_intro_requests").insert({ user_id: userId, n, ...i }).select("*").single();
        if (!r.error) return r.data;
        if (!/duplicate key|23505/.test(String(r.error.message ?? r.error.code))) throw new Error(`save the intro request: ${r.error.message}`);
      }
      throw new Error("save the intro request: numbering kept colliding");
    },
    async updateIntro(userId, n, patch, onlyIf) {
      let q = admin.from("career_intro_requests").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("n", n);
      if (onlyIf?.status) q = q.in("status", onlyIf.status);
      if (onlyIf?.payload_hash) q = q.eq("payload_hash", onlyIf.payload_hash);
      const r = must(await q.select("*"), "update the intro request") ?? [];
      return r[0] ?? null;
    },
    async forgetIntros(userId) { return (must(await admin.from("career_intro_requests").delete().eq("user_id", userId).select("id"), "forget the intro requests") ?? []).length; },
    // In the database, one statement over every other chat of theirs (on the user_id index), each chat's revision moved so a
    // stale turn can't save the old list back (career_people_prune_thread_contacts). Then a read-back: none is left.
    async pruneThreadContacts(userId, exceptThread, all) {
      const r = must(await admin.rpc("career_people_prune_thread_contacts", { p_user: userId, p_except: exceptThread, p_all: all }), "forget your chats' contact lists");
      const again = must(await admin.rpc("career_people_prune_thread_contacts", { p_user: userId, p_except: exceptThread, p_all: all }), "read back your chats' contact lists");
      if (Number(again?.rows ?? 0) > 0) throw new Error("forget your chats' contact lists: rows remained after the delete");
      return { rows: Number(r?.rows ?? 0), threads: Number(r?.threads ?? 0) };
    },
  };
}

// ------------------------------------------------------------------------------------------------ deps
export interface PeopleDeps {
  store: PeopleStore;
  gmail: GmailRead | null; // null: no Gmail reading here
  fetch: typeof fetch;     // Gmail's API (a public page is never read with fetch: see pageGet)
  // The scheduled push for intro reminders is wired (CAREER_INTRO_REMINDERS=on at career-proactive): the remind
  // reply's words follow this flag, the same way the alert copy follows its delivery flag — off, the reminder is
  // brought up at the person's next message and the reply says exactly that.
  introPush?: boolean;
  // Whether this person has a texting channel the push can reach. Absent, or false: the reply never promises a text.
  canText?: (userId: string) => Promise<boolean>;
  // The page reader's DNS (career_people_page.ts); absent: the runtime's.
  resolve?: Resolver;
  // A public page is read over a connection pinned to the address its name was checked at (career_people_page.ts
  // pinnedGet); absent: the runtime's TCP and TLS. Tests pass one that serves fixtures.
  pageGet?: PageGet;
  // Gmail reads in full: the saved cursors (career_people_sweep.ts). Absent: a cursor kept for this call only.
  sweeps?: SweepStore;
  // The scheduled run carries unfinished Gmail reads on (CAREER_PEOPLE_SWEEP=on at career-proactive): the reply's words
  // follow this flag. Off, a read that isn't finished goes on at the person's next ask, and the reply says exactly that.
  sweepPush?: boolean;
  // People discovery (career_people_provider.ts, D-MN-3 as replaced: web search + public pages, no paid provider):
  // "engineering managers at Stripe", "people at every company I applied to", "alumni of X at Y" go to findTargets.
  // Present with provider null when CAREER_PEOPLE_SEARCH is off: the reply then says plainly that searching the web
  // isn't switched on and answers from the person's own contacts. Absent: those asks are answered as before.
  targets?: TargetDeps | null;
}
// The live wiring, built by the caller (agent-chat/handler-career.ts) from the clients it already holds and passed in as
// `people`; this module never reads the process environment or makes a client of its own. No `people` (the unit tests
// that call networkingTurn alone): there is no people turn, and the networking turn answers exactly as before.
// deno-lint-ignore no-explicit-any
// `env` (the caller's environment reader) wires people discovery; its switch and key are read there, never here.
export function supabasePeopleDeps(admin: any, o: { fetch: typeof fetch; token: GmailRead["token"]; introPush: boolean; sweepPush?: boolean; resolve?: Resolver; env?: (k: string) => string | undefined }): PeopleDeps {
  const cfg = o.env ? providerConfig(o.env) : null;
  return {
    targets: cfg ? { store: supabaseProviderStore(admin), config: cfg, provider: makeProvider(cfg, o.fetch, { resolve: o.resolve }), now: Date.now } : null,
    store: supabasePeopleStore(admin), gmail: { fetch: o.fetch, token: o.token }, fetch: o.fetch, introPush: o.introPush, resolve: o.resolve,
    sweeps: supabaseSweepStore(admin), sweepPush: !!o.sweepPush,
    // A texting channel the outbox can deliver to (channel_contacts, not opted out): the scheduled push reaches only them.
    canText: async (userId) => {
      const r = await admin.from("channel_contacts").select("contact").eq("user_id", userId).eq("opted_out", false).limit(1);
      if (r.error) throw new Error(`read the texting channel: ${r.error.message}`);
      return (r.data ?? []).length > 0;
    },
  };
}
export { CAREER_READ_SCOPE, careerTokenFor };

export interface PeopleTurnIn {
  message: string; userId: string; threadId: string; now: number;
  state: Record<string, unknown>;
  attachments?: { name: string; mime?: string; text: string | null }[];
  store: OutreachStore; model: ModelFn | null;
  people?: PeopleDeps | null;
}
export interface PeopleResult { reply: string; intent: string; status: string }

// ------------------------------------------------------------------------------------------------ what was asked
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, a: 1 };
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}@.]+/gu, " ").trim();
const FILLER = /^(?:(?:so|ok|okay|hey|hi|yo|and|now|also|please|pls|plz|can you|can u|could you|could u|would you|will you|help me|actually|wait|oh|hmm|um)[, ]+)+/i;
const tidy = (m: string) => chatAsk(m).replace(FILLER, "").replace(/[?!.]+$/, "").replace(/[, ]+(?:pls|plz|please|thanks|thx|ty)[?!.]*$/i, "").replace(/[?!.]+$/, "").trim();
const firmText = (raw: string): string | null => {
  const f = raw.replace(/\s+(?:about|regarding|re|for|who|that|to|and ask|asking|please|on|from my|in my)\b.*$/i, "").replace(/[?.!,;:]+$/, "").replace(/^the\s+/i, "").trim();
  return f && f.length <= 60 && !/[@/\\<>]/.test(f) && f.split(/\s+/).length <= 6 ? f : null;
};
const MY_SCHOOL = /^(?:(?:my|our)\b.*|fellow|(?:school|college|university)(?:['’]s)?)$/i;
const NAME_WORDS = /^[\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,3}$/u;
const NOT_A_NAME = /^(?:someone|somebody|anyone|anybody|people|a person|the|my|me|them|him|her|you|a|an|recruiters?|contacts?|connections?|everyone)\b/i;

export type Ask =
  | { kind: "forget"; what: "linkedin" | "gmail" | "jobs" | "intros" | "all" }
  | { kind: "intro"; name: string | null; firm: string | null; topic: string | null }
  | { kind: "intro_cmd"; n: number | null; verb: "approve" | "redo" | "cancel" | "sent" | "replied" | "no_reply" | "remind"; days?: number }
  | { kind: "intro_list" }
  | { kind: "alumni"; firm: string; school: string | null }
  | { kind: "school_set"; name: string; school: string }
  | { kind: "jobs" }
  | { kind: "page"; url: string; firm: string | null; owner: string | null }
  | { kind: "who"; firm: string };

export function parsePeopleAsk(message: string): Ask | null {
  const raw = String(message ?? "");
  const t = tidy(raw);
  if (!t || t.length > 400) return null;
  // forget
  const fg = /^(?:forget|delete|remove|erase|clear|wipe)\s+(?:all\s+(?:of\s+)?)?(?:my\s+)?(.+)$/i.exec(t);
  // ROUTING SCENARIOS (2026-10-29): "remove LinkedIn from my list" names an employer to take off the apply list (the cancel
  // turn's), never the LinkedIn export to delete.
  if (fg && !/\b(?:off|from) (?:my|the) (?:application |apply )?(?:list|queue)\b/i.test(fg[1])) {
    const w = fg[1].toLowerCase();
    // The site's own data, named whole ("my LinkedIn contacts", "my handshake and indeed jobs"): an employer that carries
    // the name ("Handshake Capital", "Indeed Partners from my list") is not it.
    if (/^linked\s?in(?:\s+(?:contacts|connections|export|data|network|people|csv|file|list))?$|^(?:linked\s?in\s+)?connections\b/.test(w)) return { kind: "forget", what: "linkedin" };
    if (/^(?:gmail|email|mail)\s+(?:contacts|people|correspondents)\b/.test(w)) return { kind: "forget", what: "gmail" };
    if (/^(?:handshake|indeed)(?:\s+(?:and|&)\s+(?:handshake|indeed))?(?:\s+(?:jobs?|job emails|emails|alerts|job alerts|postings|listings|data))?$|^(?:job (?:alert )?emails|job alerts)\b/.test(w)) return { kind: "forget", what: "jobs" };
    if (/^intro(?:duction)?s?(?: requests?)?\b/.test(w)) return { kind: "forget", what: "intros" };
    if (/^(?:contacts|people|network)\b/.test(w)) return { kind: "forget", what: "all" };
  }
  // intro commands
  const days = (w: string) => /^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? null;
  let m = /^(approve|ok approve|yes approve|redo|rewrite|cancel|drop)\s+intro(?:duction)?\s*#?(\d{1,5})$/i.exec(t);
  if (m) { const v = m[1].toLowerCase(); return { kind: "intro_cmd", n: Number(m[2]), verb: /approve/.test(v) ? "approve" : /redo|rewrite/.test(v) ? "redo" : "cancel" }; }
  m = /^(?:i\s+)?(?:sent|have sent|just sent)\s+intro(?:duction)?\s*#?(\d{1,5})$/i.exec(t) ?? /^intro(?:duction)?\s*#?(\d{1,5})\s+(?:is\s+|was\s+|has been\s+)?sent$/i.exec(t);
  if (m) return { kind: "intro_cmd", n: Number(m[1]), verb: "sent" };
  m = /^intro(?:duction)?\s*#?(\d{1,5})\s+(?:(?:got\s+(?:a\s+)?)?(repl(?:y|ied))|(no reply|no response|didn'?t reply|never replied|no answer))$/i.exec(t);
  if (m) return { kind: "intro_cmd", n: Number(m[1]), verb: m[2] ? "replied" : "no_reply" };
  m = /^remind me(?:\s+about\s+intro(?:duction)?\s*#?(\d{1,5}))?\s+(?:in|after)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|a)\s+(days?|weeks?)(?:\s+if\s+(?:there'?s\s+|i\s+get\s+)?no\s+(?:reply|response|answer))?(?:\s+about\s+intro(?:duction)?\s*#?(\d{1,5}))?$/i.exec(t);
  if (m) { const d = days(m[2]); if (d) return { kind: "intro_cmd", n: m[1] || m[4] ? Number(m[1] || m[4]) : null, verb: "remind", days: /week/i.test(m[3]) ? d * 7 : d }; }
  if (/^(?:(?:show|list|what are)(?: me)?\s+)?my\s+intro(?:duction)?s?(?:\s+requests?)?(?:\s+status)?$|^intro(?:duction)?s?\s+status$|^(?:whats|what'?s|what is) the status of my intro(?:duction)?s?$/i.test(t)) return { kind: "intro_list" };
  // a page they sent
  const url = /https?:\/\/[^\s<>"')]+/i.exec(raw)?.[0]?.replace(/[.,;!?]+$/, "");
  if (url && /\b(team|about|people|staff|leadership|who works|site|website|page|homepage|directory|founders?|contact|employees|names)\b/i.test(raw)) {
    const firm = /\b(?:at|for)\s+([\p{L}\d][\p{L}\d&.' -]{0,59}?)\s*(?:on|from|:|,|-|\(|https?:)/iu.exec(raw)?.[1]?.trim() ?? /(?:^|[\s,])([\p{Lu}\d][\p{L}\d&.-]*(?:\s+[\p{Lu}][\p{L}\d&.-]*){0,3})['’]s\s+(?:team|about|people|staff|leadership|careers)\b/u.exec(raw.trim())?.[1]?.trim() ?? null;
    const owner = /\b([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,3})['’]s\s+(?:own\s+|personal\s+)?(?:site|website|homepage)\b/u.exec(raw)?.[1] ?? null;
    return { kind: "page", url, firm: firm && !/^(?:my|the|this|their|his|her)$/i.test(firm) ? firm : null, owner };
  }
  // jobs from alert emails
  if (/\b(handshake|indeed)\b/i.test(t) && /\b(jobs?|postings?|alerts?|emails?|openings?|roles?|listings?)\b/i.test(t) && !/^(?:apply|submit)\b/i.test(t)) return { kind: "jobs" };
  if (/^(?:check|read|show|scan|any)\b.*\bjob alert(?:s| emails?)\b/i.test(t)) return { kind: "jobs" };
  // "Maya Chen went to DePaul"
  m = /^([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,3})\s+(?:went to|studied at|graduated from|is an? alum(?:nus|na)? of|is a graduate of)\s+(.{2,80})$/u.exec(t);
  if (m) return { kind: "school_set", name: m[1], school: m[2].replace(/^the\s+/i, "").trim() };
  // alumni
  m = /^(?:(?:find|show|list|who are|any|are there(?: any)?)(?:\s+me)?(?:\s+(?:the|my|any|some))?\s+)?(?:(.+?)\s+)?(?:alumni|alums?|alumnae|grads|graduates)(?:\s+(?:from|of)\s+(.+?))?\s+(?:at|in|working at|who work at|that work at)\s+(.+)$/i.exec(t);
  if (m) {
    const firm = firmText(m[3]);
    const lead = (m[1] ?? "").replace(/^(?:the|my|any|some|fellow|our)\s*/i, "").trim();
    const school = (m[2] ?? lead).trim() || null;
    // NETWORKING SCENARIOS (2026-10-29): "alumni from my school / my college / our university at X" names no school: the
    // person's confirmed education is used, never a school called "my school".
    if (firm) return { kind: "alumni", firm, school: school && !MY_SCHOOL.test(school) ? school : null };
  }
  m = /^who\s+from\s+(.+?)\s+(?:works?|is|are)\s+(?:at|in)\s+(.+)$/i.exec(t);
  if (m) { const firm = firmText(m[2]); if (firm) return { kind: "alumni", firm, school: MY_SCHOOL.test(m[1].trim()) ? null : m[1].trim() || null }; }
  // introductions
  const ir = /^(?:(?:can you |could you |help me |i (?:want|need|would like|'?d like) (?:to )?)?(?:get|find|set up|ask for|make|arrange)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:warm\s+)?intro(?:duction)?\s+(?:to|with)|introduce me to|(?:a\s+|an\s+)?(?:warm\s+)?intro(?:duction)?\s+to|how (?:can|do|could) i (?:get (?:a |an )?(?:warm )?intro(?:duction)? to|get introduced to|meet|reach)|who can introduce me to|connect me (?:to|with))\s+(.+)$/i.exec(t);
  if (ir && !/^draft\b/i.test(t)) {
    let rest = ir[1], topic: string | null = null;
    const tm = /\s+(?:about|regarding|re|to (?:ask|talk|chat) about|for (?:a|an|the|my))\s+(.+)$/i.exec(rest);
    if (tm) { topic = tm[0].trim().replace(/^(?:about|regarding|re|to (?:ask|talk|chat) about)\s+/i, "").slice(0, 200); rest = rest.slice(0, tm.index).trim(); }
    if (/^(?:my|the)\s+(?:\d+\s+)?(?:contacts|connections)\b/i.test(rest)) return null;
    const at = /^(.+?)\s+(?:at|from)\s+(.+)$/i.exec(rest);
    const who = (at ? at[1] : rest).trim(), firm = at ? firmText(at[2]) : null;
    if (at && !firm) return null;
    if (/^(?:someone|somebody|anyone|anybody|people|a person|the right person|someone senior)$/i.test(who)) return firm ? { kind: "intro", name: null, firm, topic } : null;
    if (!NAME_WORDS.test(who) || NOT_A_NAME.test(who)) return null;
    return { kind: "intro", name: who, firm, topic };
  }
  // who do I know at X (the networking turn's own phrasings)
  const w = parseNetworkingAsk(raw) ?? parseNetworkingAsk(t);
  if (w?.kind === "who") return { kind: "who", firm: w.firm };
  return null;
}

// ------------------------------------------------------------------------------------------------ the turn
const fmtN = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, w: string) => `${fmtN(n)} ${n === 1 ? w : w === "person" ? "people" : w === "named person" ? "named people" : `${w}s`}`;
const day = (iso: string | null) => (iso ? String(iso).slice(0, 10) : "");

export const STORE_ERROR = "Something went wrong with your saved contacts just now, so I can't confirm that anything was read, saved or deleted. Please try again in a minute.";
// Only a message that is a people ask (a LinkedIn export sent or pasted, the next part of one, or an ask parsePeopleAsk
// reads) ever touches the store, so a store that is down answers with an error only for those; every other message
// (a plain contacts list, small talk, anything another turn answers) goes on exactly as if this turn weren't here.
export async function peopleTurn(o: PeopleTurnIn): Promise<PeopleResult | null> {
  const deps = o.people ?? null;
  if (!deps) return null;
  const failed = (e: unknown): PeopleResult => {
    console.error("people turn:", e instanceof Error ? e.message : e);
    return { reply: STORE_ERROR, intent: AT_INTENT, status: "error" };
  };
  const files = (o.attachments ?? []).filter((f) => f && typeof f === "object");
  if (files.length) { try { const r = await fileTurn(o, deps, files); if (r) return r; } catch (e) { return failed(e); } }
  const paste = pasteKind(o.message);
  if (paste) { try { const r = await pasteTurn(o, deps, paste); if (r) return r; } catch (e) { return failed(e); } }
  // An alumni ask with web search off is answered from their own contacts (alumniTurn), which says what the export lacks.
  const target0 = deps.targets ? targetAskOf(o.message) : null;
  const alumniAsk = target0?.kind === "alumni" || parsePeopleAsk(o.message)?.kind === "alumni";
  const target = target0 && !(alumniAsk && !deps.targets!.provider) ? target0 : null;
  if (target) { try { return await targetsTurn(o, deps.targets!, target); } catch (e) { return failed(e); } }
  const ask = parsePeopleAsk(o.message);
  if (!ask) return null;
  try {
    const due = ask.kind === "intro_list" ? "" : await dueLine(o, deps);
    const r = await answer(o, deps, ask);
    return r && due ? { ...r, reply: `${due}\n\n${r.reply}` } : r;
  } catch (e) { return failed(e); }
}

async function answer(o: PeopleTurnIn, d: PeopleDeps, a: Ask): Promise<PeopleResult | null> {
  switch (a.kind) {
    case "forget": return await forgetTurn(o, d, a.what);
    case "who": return await whoTurn(o, d, a.firm);
    case "alumni": return await alumniTurn(o, d, a.firm, a.school);
    case "school_set": return await schoolTurn(o, d, a.name, a.school);
    case "page": return await pageTurn(o, d, a);
    case "jobs": return await jobsTurn(o, d);
    case "intro": return await introTurn(o, d, a);
    case "intro_cmd": return await introCmd(o, d, a);
    case "intro_list": return await introList(o, d);
  }
}

// ------------------------------------------------------------------------------------------------ discovery targets
// An ask findTargets answers. "my school alumni at Stripe" (no school named) stays alumniTurn's, which uses the
// person's confirmed education.
export function targetAskOf(message: string): TargetAsk | null {
  // An ask that names LinkedIn, Indeed or Handshake is never a search of ours: the refusal turn answers it plainly.
  if (/\b(?:linked ?in|indeed|handshake)\b/i.test(message)) return null;
  const t = parseTargetAsk(tidy(message)) ?? parseTargetAsk(message);
  if (t?.kind === "alumni" && (/^(?:my|our|fellow|the|any|some)\b/i.test(t.school) || /^(?:school|college|university)$/i.test(t.school))) return null;
  return t;
}
// Candidates with a reason line each: title, why they match, the page that names them, the address and its label
// (published / known / inferred). Every one is saved in career_people (the drafter reads all of them); the chat lists
// the first LIST_MAX and says how many more are saved.
async function targetsTurn(o: PeopleTurnIn, t: TargetDeps, ask: TargetAsk): Promise<PeopleResult> {
  const r = await findTargets(o.userId, ask, t);
  const shown = r.candidates.slice(0, LIST_MAX).map((c, i) => `${i + 1}. ${c.name}${c.email ? ` <${c.email}>${c.address ? ` (${c.address})` : ""}` : ""}: ${c.reason}`);
  const rest = r.candidates.length - shown.length;
  const more = rest > 0 ? `${fmtN(rest)} more ${rest === 1 ? "person is" : "people are"} saved with your contacts; a draft can reach any of them.` : "";
  return { reply: [r.reply, ...shown, more].filter(Boolean).join("\n"), intent: TARGETS_INTENT, status: r.status };
}

// ------------------------------------------------------------------------------------------------ import
const WHY: Record<string, string> = {
  empty: "it was empty", too_large: "it is too large to read here (the limit is 30 MB for a ZIP and 20 MB of text)",
  no_header: "I couldn't find a header row with a name column and a Company or Email column",
  no_rows: "it has a header but no rows", not_zip: "it isn't a ZIP file", corrupt: "the file is damaged or isn't what its name says",
  no_connections: "the ZIP has no Connections.csv in it (pick Connections when you request the archive)",
  encrypted: "the ZIP is password-protected", unsupported: "the ZIP uses a compression I can't read",
  bomb: "it unpacks to far more data than a connections list could be, so I stopped reading it", unreadable: "I couldn't read its text",
};
async function fileTurn(o: PeopleTurnIn, d: PeopleDeps, files: NonNullable<PeopleTurnIn["attachments"]>): Promise<PeopleResult | null> {
  const lines: string[] = [];
  let mine = false, imported = 0;
  const others: string[] = [];
  for (const f of files.slice(0, 3)) {
    const nameZip = /\.zip$/i.test(String(f.name)) || /zip/i.test(String(f.mime ?? ""));
    const got = await peopleFileText({ name: f.name, mime: f.mime, text: f.text });
    if (!got.ok) {
      if (!nameZip && !/linkedin|connections/i.test(String(f.name))) { others.push(cleanCell(f.name, 120) || "a file"); continue; } // not ours
      mine = true;
      lines.push(`${cleanCell(f.name, 120) || "That file"}: nothing imported, because ${WHY[got.why] ?? "I couldn't read it"}.`);
      continue;
    }
    const parsed = parseExport(got.name, got.text);
    if (!parsed.ok) {
      if (!got.zipped && !/linkedin|connections/i.test(String(f.name))) { others.push(got.name); continue; }
      mine = true;
      lines.push(`${got.name}: nothing imported, because ${WHY[parsed.why] ?? "I couldn't read it"}.`);
      continue;
    }
    if (parsed.kind !== "linkedin_export") { others.push(got.name); continue; } // another list: the contacts importer keeps it, as before
    mine = true;
    const r = await saveExport(o, d, got.name, await sha256Hex(got.text), parsed, true);
    imported += r.inserted;
    lines.push(r.line);
  }
  if (!mine) return null;
  if (others.length) lines.push(`${others.join(", ")}: not read in this message. Send ${others.length === 1 ? "it" : "each"} on its own and I'll import it.`);
  if (files.length > 3) lines.push(`I read the first 3 files; send the rest in another message.`);
  return { reply: lines.join("\n"), intent: IMPORT_INTENT, status: imported ? "imported" : "not_imported" };
}

const LINKEDIN_HEADER = /(^|\n)\s*"?first name"?\s*,\s*"?last name"?\s*,.*connected on/i;
// Pure, before any read: is this message a pasted export ("header") or rows shaped like the export's ("rows": each row
// has a LinkedIn profile link or a "14 Mar 2025" date), the only pastes that are this turn's.
function pasteKind(message: string): "header" | "rows" | null {
  const text = String(message ?? "");
  if (!/\n/.test(text) || !/,/.test(text)) return null;
  if (LINKEDIN_HEADER.test(text)) return "header";
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && !r[0].trim()));
  return rows.length >= 1 && rows.every((r) => /linkedin\.com\/in\//i.test(r.join(",")) || r.some((c) => /^\d{1,2} [A-Za-z]{3} \d{4}$/.test(c.trim()))) ? "rows" : null;
}
async function pasteTurn(o: PeopleTurnIn, d: PeopleDeps, kind: "header" | "rows"): Promise<PeopleResult | null> {
  const text = String(o.message ?? "");
  if (kind === "header") {
    const parsed = parseExport(LINKEDIN_FILE, text);
    if (!parsed.ok || parsed.kind !== "linkedin_export") return null;
    const header = text.split(/\r?\n/).find((l) => /first name/i.test(l) && /connected on/i.test(l))!.trim().slice(0, 2000);
    const file = `${LINKEDIN_FILE} (pasted ${new Date(o.now).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
    await d.store.setPrefs(o.userId, { paste_header: header, paste_file: file, paste_at: new Date(o.now).toISOString() });
    const r = await saveExport(o, d, file, null, parsed, false);
    return { reply: `${r.line} If there's more, paste the next part; I'll read it under the same header for the next hour.`, intent: IMPORT_INTENT, status: r.inserted ? "imported" : "not_imported" };
  }
  // the next part of a long paste: rows only, read under the last part's header
  const p = await d.store.prefs(o.userId);
  if (!p.paste_header || !p.paste_at || o.now - Date.parse(p.paste_at) > PASTE_WINDOW_MS) return null;
  const width = parseCsv(p.paste_header)[0]?.length ?? 0;
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && !r[0].trim()));
  if (rows.length < 1 || width < 3 || rows.some((r) => r.length !== width)) return null;
  const parsed = parseExport(p.paste_file ?? LINKEDIN_FILE, `${p.paste_header}\n${text}`);
  if (!parsed.ok) return null;
  await d.store.setPrefs(o.userId, { paste_at: new Date(o.now).toISOString() });
  const r = await saveExport(o, d, p.paste_file ?? LINKEDIN_FILE, null, parsed, false);
  return { reply: `${r.line} Paste the next part if there is one.`, intent: IMPORT_INTENT, status: r.inserted ? "imported" : "not_imported" };
}

function skippedLine(s: { row: number; why: string }[]): string[] {
  const by = new Map<string, number[]>();
  for (const x of s) by.set(x.why, [...(by.get(x.why) ?? []), x.row]);
  return [...by.entries()].map(([why, rows]) => `${rows.length === 1 ? "row" : "rows"} ${rows.slice(0, 5).join(", ")}${rows.length > 5 ? ` and ${fmtN(rows.length - 5)} more` : ""}: ${why}`);
}
async function saveExport(o: PeopleTurnIn, d: PeopleDeps, file: string, sha: string | null, p: ParsedExport, replace: boolean): Promise<{ inserted: number; line: string }> {
  const rows = p.rows.map((r: PersonRow) => ({ ...r, source_url: null, last_seen_at: null }));
  const saved = await d.store.importRows(o.userId, "linkedin_export", file.slice(0, 300), sha, rows, p.read, p.skipped.length, replace);
  await mirror(o, file, p.rows, replace);
  const total = p.read;
  const left = [...(p.duplicates ? [plural(p.duplicates, "duplicate")] : []), ...(saved.duplicates ? [`${fmtN(saved.duplicates)} already saved`] : []), ...skippedLine(p.skipped)];
  const mailed = p.rows.filter((r) => r.email).length;
  const blanked = p.blanked ? ` I blanked ${plural(p.blanked, "cell")} that a spreadsheet would run as a formula.` : "";
  const line = `${file}: imported ${fmtN(saved.inserted)}/${fmtN(total)} rows into your contacts${left.length ? ` (left out: ${left.join("; ")})` : ""}. ${fmtN(mailed)}/${fmtN(p.rows.length)} have an email address; LinkedIn includes one only when the person allowed it, and I never guess an address.${blanked}`;
  return { inserted: saved.inserted, line };
}
// The thread's contacts list (the email drafter's): at most MIRROR_MAX rows of this export, those with an address first.
const fromExport = (r: ContactRow) => (r as unknown as { linkedin_export?: boolean }).linkedin_export === true || /connections\.csv/i.test(r.file);
async function mirror(o: PeopleTurnIn, file: string, rows: PersonRow[], replace: boolean) {
  const pick = [...rows.filter((r) => r.email), ...rows.filter((r) => !r.email)].slice(0, MIRROR_MAX);
  const at = new Date(o.now).toISOString();
  const asRows: ContactRow[] = pick.map((r) => ({ file, row: Number(/row (\d+)$/.exec(r.source_ref)?.[1] ?? 0), name: r.name, email: r.email, firm: normalizeFirm(r.company), firm_raw: r.company,
    company: normalizeFirm(r.company), title: r.position, school: r.school, connected_on: r.connected_on, source_kind: "own_export", retrieved_at: at, linkedin_export: true } as ContactRow));
  const checked = await verifyRows(asRows, MX_NOT_WIRED);
  // a file replaces every earlier copy of the export; a pasted part adds to it
  const kept = contactsOf(o.state).filter((r) => r.file !== file && !(replace && fromExport(r)));
  o.state.contacts = [...kept, ...checked].slice(-3000);
}

// ------------------------------------------------------------------------------------------------ who, alumni
const fromWhere = (p: PersonRec) =>
  p.source === "linkedin_export" ? `your LinkedIn export${p.connected_on ? `, connected ${p.connected_on}` : ""}`
  : p.source === "gmail" ? `your Gmail${p.last_seen_at ? `, last email ${day(p.last_seen_at)}` : ""}`
  : p.source === "company_page" ? `published on ${p.source_url}` : p.source_ref.replace(/, row \d+$/, "");
const lineOf = (p: PersonRec) => `- ${p.name ?? p.email}${p.position ? `, ${p.position}` : ""}${p.email ? ` (${p.email})` : " (no email address)"} · ${fromWhere(p)}`;
function stateRows(o: PeopleTurnIn): PersonRec[] {
  return contactsOf(o.state).map((r) => ({ id: null, source: "thread_list" as const, name: r.name, email: r.email, company: r.firm || r.company, company_key: companyKey(r.firm || r.company),
    position: r.title, school: r.school, connected_on: r.connected_on, last_seen_at: null, source_ref: `${r.file}, row ${r.row}`, source_url: null, retrieved_at: String((r as any).retrieved_at ?? "") }));
}
// One person once: same address, or same name at the same firm; the row with an address (then the export's) wins.
function uniq(rows: PersonRec[]): PersonRec[] {
  const out: PersonRec[] = [];
  const byEmail = new Map<string, number>(), byName = new Map<string, number>();
  const rank = (p: PersonRec) => (p.email ? 2 : 0) + (p.source === "linkedin_export" ? 1 : 0);
  for (const p of rows) {
    const nk = p.name ? `${plain(p.name)}|${p.company_key}` : null;
    const i = (p.email ? byEmail.get(p.email) : undefined) ?? (nk ? byName.get(nk) : undefined);
    if (i === undefined) { out.push(p); if (p.email) byEmail.set(p.email, out.length - 1); if (nk) byName.set(nk, out.length - 1); continue; }
    const x = out[i];
    const keep = rank(p) > rank(x) ? { ...p, school: p.school || x.school, position: p.position || x.position } : { ...x, email: x.email ?? p.email, school: x.school || p.school, position: x.position || p.position };
    out[i] = keep;
    if (keep.email) byEmail.set(keep.email, i);
    if (nk) byName.set(nk, i);
  }
  return out;
}
// Where a sweep keeps what it read: people from Gmail headers (career_people, source gmail; one row per address) and
// postings from alert emails (career_job_emails, once per link). Used by the turn and by the scheduled run alike.
export function peopleSink(store: PeopleStore): SweepSink {
  return {
    async people(userId, label, key, items, read) {
      await store.importRows(userId, "gmail", `Gmail, people at ${label}`, null, items.map((c) => ({
        name: c.name, email: c.email, company: c.domain, company_key: key, position: "", school: "", connected_on: null, last_seen_at: c.last_seen_at,
        source_ref: `Gmail message ${c.message_hash.slice(0, 12)}`, source_url: null, dedupe_key: `e:${c.email}`,
      })), read, 0, false);
    },
    async jobs(userId, items) {
      return await store.saveJobs(userId, items.map((j) => ({ source: j.source, title: j.title, detail: j.detail, url: j.url, message_hash: j.message_hash, received_at: j.received_at })));
    },
  };
}
const sweepsOf = (d: PeopleDeps) => (d.sweeps ??= memorySweepStore());
type GmailState = "read" | "not_connected" | "error" | "not_a_domain" | "more" | "busy" | "slow";
async function gmailAt(o: PeopleTurnIn, d: PeopleDeps, firm: string): Promise<{ rows: PersonRec[]; state: GmailState; sweep: SweepOutcome | null }> {
  if (!d.gmail) return { rows: [], state: "not_connected", sweep: null };
  const label = domainLabelOf(firm);
  if (!isCompanyLabel(label)) return { rows: [], state: "not_a_domain", sweep: null };
  const key = companyKey(firm);
  const r = await sweepTurn({ sweeps: sweepsOf(d), sink: peopleSink(d.store), gmail: d.gmail, userId: o.userId, kind: "correspondents", scope: label, companyKey: key });
  if (r.status === "not_connected") return { rows: [], state: "not_connected", sweep: r };
  if (r.status === "error") return { rows: [], state: "error", sweep: r };
  const rows = await d.store.atCompany(o.userId, key).then((x) => x.filter((p) => p.source === "gmail"));
  return { rows, state: r.status === "read" ? (r.more ? "more" : "read") : r.status, sweep: r };
}
async function everyoneAt(o: PeopleTurnIn, d: PeopleDeps, firm: string) {
  const key = companyKey(firm);
  const stored = await d.store.atCompany(o.userId, key);
  const g = await gmailAt(o, d, firm);
  const list = stateRows(o).filter((p) => p.company_key === key);
  // A full page means there are more on file than one turn reads: the database's own count is the total then.
  const more = stored.length >= PAGE && d.store.tallies ? await d.store.tallies(o.userId, key) : null;
  // NETWORKING SCENARIOS (2026-10-29): people a web search found for them (source "provider") are not people they know:
  // "who do I know at X" listed them as contacts, with an inferred address shown as if it were theirs. Discovery answers
  // "find recruiters at X" (labeled published / known / inferred); a draft can still reach them (savedPeople, labeled).
  return { people: uniq([...stored.filter((p) => p.source !== "gmail" && p.source !== "provider"), ...g.rows, ...list]), gmail: g.state, sweep: g.sweep, stored: more ? more.at_company : null };
}
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
// What is still being read, said plainly: how far the read is, and when the rest comes (the scheduled run, or their next ask).
function moreNote(w: SweepOutcome | null, what: string, push: boolean | undefined): string {
  if (!w) return "";
  if (w.status === "read" && w.more) return `I've read ${plural(w.readSoFar, "email")} ${what} so far and there are more; ${push ? "I'm reading the rest now, so ask again in a few minutes to see everything." : "ask again and I'll read the next part."}`;
  if (w.status === "busy") return `I'm already reading your emails ${what} (${plural(w.readSoFar, "email")} so far); ask again in a minute to see the rest.`;
  if (w.status === "slow") return `Gmail asked me to slow down, so I paused reading your emails ${what} after ${plural(w.readSoFar, "email")}; ${push ? `I'll pick it up again after ${hhmm(w.retryAt)}.` : `ask again after ${hhmm(w.retryAt)} and I'll continue.`}`;
  return "";
}
const gmailNote = (s: string, firm: string, w: SweepOutcome | null = null, push?: boolean) =>
  s === "not_connected" ? `Your Gmail isn't connected, so I didn't check who you've emailed at ${firm}. To include them, connect it (read-only):\n${connectUrl("gmail")}`
  : s === "error" ? "I couldn't read your Gmail just now, so people you've emailed aren't included."
  : moreNote(w, `with ${firm}`, push);

async function askForExport(o: PeopleTurnIn, d: PeopleDeps): Promise<string> {
  const p = await d.store.prefs(o.userId);
  if (p.export_asked_at) return EXPORT_AGAIN;
  await d.store.setPrefs(o.userId, { export_asked_at: new Date(o.now).toISOString() });
  return EXPORT_STEPS;
}
async function whoTurn(o: PeopleTurnIn, d: PeopleDeps, firmAsked: string): Promise<PeopleResult | null> {
  const counts = await d.store.counts(o.userId);
  const total = Object.entries(counts).reduce((a, [k, b]) => a + (k === "provider" ? 0 : b ?? 0), 0); // discovered people aren't contacts
  const listed = stateRows(o);
  const gmailOn = d.gmail ? !!(await d.gmail.token(o.userId).catch(() => null)) : false;
  // Only their earlier lists, no export and no Gmail: the networking turn answers, as before.
  if (!total && listed.length && !gmailOn) return null;
  const firm = cleanCell(firmAsked, 60);
  const { people, gmail, sweep, stored } = await everyoneAt(o, d, firm);
  if (!people.length) {
    const none = total + listed.length
      ? `None of your ${plural(total + listed.length, "contact")} is at ${firm}.`
      : `You haven't sent me any contacts yet, so I can't say who you know at ${firm}.`;
    const ask = counts.linkedin_export ? `If ${firm} publishes a team page, send me its link and I'll read the names it lists. ${NO_SEARCH}` : await askForExport(o, d);
    return { reply: [none, NO_FINDER, ask, gmailNote(gmail, firm, sweep, d.sweepPush)].filter(Boolean).join(" ").replace(/ (Your Gmail isn't connected)/, "\n\n$1"), intent: AT_INTENT, status: total + listed.length ? "none_at_firm" : "no_contacts" };
  }
  const mailed = people.filter((p) => p.email).length;
  const shown = people.slice(0, LIST_MAX);
  // More on file than one page: the count is the database's (rows kept for that company), never the page's.
  const head = stored !== null && stored > people.length
    ? `You have ${plural(stored, "contact")} at ${firm} on file; here are the first ${fmtN(shown.length)}, those with an email address first:`
    : `You have ${plural(people.length, "contact")} at ${firm}, ${fmtN(mailed)} with an email address:`;
  const rest = (stored !== null && stored > people.length ? stored : people.length) - shown.length;
  const lines = [head, ...shown.map(lineOf),
    ...(rest > 0 ? [`and ${fmtN(rest)} more.`] : []),
    `\nSay "intro to <name> at ${firm}" for a note you can send, or "get me an intro to <someone there>" and I'll find who can introduce you.`,
    gmailNote(gmail, firm, sweep, d.sweepPush) ? `\n${gmailNote(gmail, firm, sweep, d.sweepPush)}` : ""];
  return { reply: lines.filter(Boolean).join("\n"), intent: AT_INTENT, status: "listed" };
}
const factSchools = (o: PeopleTurnIn) => confirmed((((o.state.profile as any)?.facts) ?? []) as unknown[]).filter((f: any) => f.kind === "education").map((f: any) => factText(f));
const schoolMatch = (contactSchool: string, want: string) => { const a = plain(contactSchool), b = plain(want); return !!a && !!b && (a.includes(b) || b.includes(a)); };
async function alumniTurn(o: PeopleTurnIn, d: PeopleDeps, firmAsked: string, school: string | null): Promise<PeopleResult> {
  const firm = cleanCell(firmAsked, 60);
  const mine = factSchools(o);
  const schools = school ? [cleanCell(school, 80)] : mine;
  if (!schools.length) return { reply: `Which school? Say "<school> alumni at ${firm}". I didn't find a confirmed school in your profile to use.`, intent: ALUMNI_INTENT, status: "no_school" };
  const { people } = await everyoneAt(o, d, firm);
  if (!people.length) {
    const ask = (await d.store.counts(o.userId)).linkedin_export ? `If ${firm} publishes a team page, send me its link. ${NO_SEARCH}` : await askForExport(o, d);
    return { reply: `You have no contacts at ${firm} yet, so I can't say which are alumni. ${NO_FINDER} ${ask}`, intent: ALUMNI_INTENT, status: "no_contacts" };
  }
  const label = school ? cleanCell(school, 80) : "your school";
  const alumni = people.filter((p) => schools.some((s) => school ? schoolMatch(p.school, s) : !!p.school && plain(s).includes(plain(p.school))));
  const noSchool = people.filter((p) => !p.school).length;
  const gap = noSchool ? ` ${fmtN(noSchool)} of your ${plural(people.length, "contact")} there have no school on file: LinkedIn's Connections file has no school column. If you know where one studied, say "<name> went to <school>" and I'll keep it.` : "";
  if (!alumni.length) return { reply: `None of your contacts at ${firm} is on file as a ${label} alum.${gap}`, intent: ALUMNI_INTENT, status: "none" };
  return { reply: [`${plural(alumni.length, "contact")} at ${firm} on file as ${label} alumni:`, ...alumni.slice(0, LIST_MAX).map((p) => `${lineOf(p)}, school: ${p.school}`), gap.trim()].filter(Boolean).join("\n"), intent: ALUMNI_INTENT, status: "listed" };
}
async function schoolTurn(o: PeopleTurnIn, d: PeopleDeps, name: string, school: string): Promise<PeopleResult | null> {
  const hits = (await d.store.named(o.userId, name)).filter((p) => p.id !== null && p.source !== "company_page");
  if (!hits.length) return null;
  const s = cleanCell(school, 200);
  const n = await d.store.setSchool(o.userId, hits.map((p) => p.id!), s);
  return { reply: `Saved: ${hits[0].name} went to ${s} (from you; ${plural(n, "contact row")} updated).`, intent: SCHOOL_INTENT, status: "saved" };
}

// ------------------------------------------------------------------------------------------------ a public page
const PAGE_WHY: Record<string, string> = {
  bad_url: "that isn't a link I can open", not_https: "I only open https:// links", blocked_site: "I never open LinkedIn, Indeed or Handshake pages for you; send me your LinkedIn data export instead",
  private_host: "that isn't a public website address", robots: "the site asks automated readers not to open that page, so I didn't", too_large: "the page is over 2 MB",
  not_html: "that link isn't a web page", http: "the site didn't return the page", timeout: "the site didn't answer within 8 seconds", network: "I couldn't reach the site", redirects: "the link redirected too many times",
};
async function pageTurn(o: PeopleTurnIn, d: PeopleDeps, a: Extract<Ask, { kind: "page" }>): Promise<PeopleResult> {
  const c = checkUrl(a.url);
  if (!c.ok) return { reply: `I didn't open it: ${PAGE_WHY[c.why]}.`, intent: PAGE_INTENT, status: "refused" };
  const r = await readPage(d.pageGet ?? pinnedGet(), a.url, d.resolve);
  if (!r.ok) return { reply: `I didn't read it: ${PAGE_WHY[r.why]}${r.detail && r.why === "http" ? ` (${r.detail})` : ""}. Nothing was saved.`, intent: PAGE_INTENT, status: "refused" };
  const company = cleanCell(a.firm ?? r.org ?? "", 200);
  let people = r.people;
  // Someone's own site: an address it publishes with no name beside it is theirs (the person said whose site it is).
  // A company page: only named people; an unnamed address there (careers@, press@) is an inbox, not a person.
  people = a.owner ? people.map((p) => (!p.name && p.email ? { ...p, name: a.owner } : p)) : people.filter((p) => p.name);
  // NETWORKING R2 (2026-10-30): on a company's page, an address on another domain is not that person's work address: a
  // look-alike (str1pe.com, stripe.com.evil.io) or a personal mailbox. Before, it was saved as their address and drafted
  // to ("email Dana at Stripe" wrote to dana@str1pe.com). Someone the page says has left is not filed under the company.
  // #361 re-review (2026-11-01): a name-shaped domain is not proof either (stripe.xyz/team filed "maya@stripe.xyz" under
  // Stripe). An address filed under a company is kept only at that company's VERIFIED domain, one a person the user gave
  // (their export or list, never a page or a Gmail correspondent) has an address at; with none, the person is kept without
  // an address. An address filed under no company is the person's own.
  let offDomain = 0, left = 0;
  if (company) {
    const given = (await d.store.atCompany(o.userId, companyKey(company)).catch(() => [] as PersonRec[]))
      .filter((p) => p.source === "linkedin_export" || p.source === "thread_list").map((p) => p.email);
    const verified = firmDomains(given);
    people = people.map((p) => {
      if (!p.email || verified.includes(registrable(p.email.split("@")[1] ?? "").full)) return p;
      offDomain++;
      return { ...p, email: null };
    });
  }
  if (!a.owner) {
    const before = people.length;
    people = people.filter((p) => !(p.former || formerTitle(p.title)));
    left = before - people.length;
  }
  const notes = [
    ...(offDomain ? [`${plural(offDomain, "address")} on ${r.url} ${offDomain === 1 ? "is" : "are"} not at ${company}'s verified domain (one of your own contacts there has an address at; a look-alike or a personal mailbox otherwise), so I didn't save ${offDomain === 1 ? "it" : "them"} as anyone's work address.`] : []),
    ...(left ? [`${plural(left, "person")} the page lists as no longer there (former or ex-, or an end date) ${left === 1 ? "was" : "were"} not saved.`] : []),
  ];
  if (!people.length) return { reply: [`${r.url} doesn't mark anyone up as a current person there or publish an email link for one, so I took no names from it (I don't guess names from page text). Nothing was saved.`, ...notes].join(" "), intent: PAGE_INTENT, status: "no_people" };
  const at = new Date(o.now).toISOString();
  const rows = people.map((p) => ({
    name: p.name, email: p.email, company: p.company || company, company_key: companyKey(p.company || company), position: p.title, school: p.school,
    connected_on: null, last_seen_at: null, source_ref: `${r.url} (${p.how}, read ${at.slice(0, 10)})`.slice(0, 600), source_url: r.url.slice(0, 2048),
    dedupe_key: (p.email ? `e:${p.email}` : `n:${plain(p.name)}|${companyKey(p.company || company)}`).slice(0, 500),
  }));
  const saved = await d.store.importRows(o.userId, "company_page", r.url.slice(0, 300), null, rows, people.length, 0, false);
  const named = people.filter((p) => p.name), mailed = people.filter((p) => p.email);
  const shown = people.slice(0, LIST_MAX).map((p) => `- ${p.name ?? "(no name given)"}${p.title ? `, ${p.title}` : ""}${p.email ? ` (${p.email})` : ""}`);
  return {
    reply: [`${r.url} publishes ${plural(named.length, "named person")}${mailed.length ? ` and ${plural(mailed.length, "email address")}` : ""}; saved ${fmtN(saved.inserted)} new${company ? ` under ${company}` : ""}:`, ...shown,
      `I take only names a page marks up as people and addresses it publishes, and I never guess an email.${company ? "" : ` I couldn't tell which company this is; say "people at <company> on ${r.url}" to file them under it.`}`, ...notes].join("\n"),
    intent: PAGE_INTENT, status: "read",
  };
}

// ------------------------------------------------------------------------------------------------ Handshake and Indeed emails
async function jobsTurn(o: PeopleTurnIn, d: PeopleDeps): Promise<PeopleResult> {
  const off = `I read Handshake and Indeed postings from their alert emails in your Gmail (I never log in to either site), and your Gmail isn't connected. Connect it (read-only):\n${connectUrl("gmail")}`;
  if (!d.gmail) return { reply: off, intent: JOBS_INTENT, status: "not_connected" };
  const r = await sweepTurn({ sweeps: sweepsOf(d), sink: peopleSink(d.store), gmail: d.gmail, userId: o.userId, kind: "job_alerts", scope: "", companyKey: "" });
  if (r.status === "not_connected") return { reply: off, intent: JOBS_INTENT, status: "not_connected" };
  if (r.status === "error") return { reply: "I couldn't read your Gmail just now, so I didn't check your Handshake and Indeed emails. Nothing was changed.", intent: JOBS_INTENT, status: "error" };
  const all = await d.store.jobs(o.userId, LIST_MAX);
  const read = r.status === "read" ? r.read : 0, added = r.status === "read" ? r.newJobs : 0, refusedN = r.status === "read" ? r.refused : 0;
  const refused = refusedN ? ` ${plural(refusedN, "email")} that claimed to be from them didn't pass Gmail's sender check, so I skipped ${refusedN === 1 ? "it" : "them"}.` : "";
  const more = moreNote(r, "from Handshake and Indeed", d.sweepPush);
  if (!all.length) {
    const head = r.status === "read" && !r.more ? `I read ${plural(r.readSoFar, "email")} from Handshake and Indeed in the last 30 days and found no job links in them.` : "No job links from Handshake or Indeed yet.";
    return { reply: [head + refused, more].filter(Boolean).join(" "), intent: JOBS_INTENT, status: r.status === "read" && !r.more ? "none" : "reading" };
  }
  const site = (s: string) => s === "indeed" ? "Indeed" : "Handshake";
  return {
    reply: [`From your Handshake and Indeed emails (${fmtN(read)} read just now, ${fmtN(added)} new posting${added === 1 ? "" : "s"}), the newest ${fmtN(all.length)}:`,
      ...all.map((j) => `- ${j.title}${j.detail ? ` · ${j.detail}` : ""} (${site(j.source)}, ${day(j.received_at)})\n  ${j.url}`),
      `Each link is the one in the email. I never log in to Handshake or Indeed.${refused}`, ...(more ? [more] : [])].join("\n"),
    intent: JOBS_INTENT, status: "listed",
  };
}

// ------------------------------------------------------------------------------------------------ forget
async function forgetTurn(o: PeopleTurnIn, d: PeopleDeps, what: Extract<Ask, { kind: "forget" }>["what"]): Promise<PeopleResult> {
  const parts: string[] = [];
  let n = 0;
  if (what === "linkedin" || what === "all") {
    // "provider": people found for them on public pages (career_people_provider.ts, D-MN-3) go with "forget my contacts" too.
    const sources: Source[] = what === "all" ? ["linkedin_export", "gmail", "company_page", "provider"] : ["linkedin_export"];
    const gone = await d.store.forget(o.userId, sources);
    // Every copy, in every chat of theirs: the other chats first (read back there), then this one's working state.
    const drop = what === "all" ? () => true : (r: ContactRow) => fromExport(r);
    const others = await d.store.pruneThreadContacts(o.userId, o.threadId, what === "all");
    const before = contactsOf(o.state).length;
    o.state.contacts = contactsOf(o.state).filter((r) => !drop(r));
    const fromChats = before - contactsOf(o.state).length + others.rows;
    n += gone + fromChats;
    const chats = others.threads ? `your chats' lists (${plural(others.threads + (before > contactsOf(o.state).length ? 1 : 0), "chat")})` : "this chat's list";
    parts.push(what === "all" ? `Deleted all the people you gave me: ${plural(gone, "person")} from your LinkedIn export, Gmail and pages${fromChats ? `, and ${plural(fromChats, "row")} from ${chats}` : ""}.` : `Deleted your LinkedIn contacts: ${plural(gone, "person")} from your export${fromChats ? ` and ${fmtN(fromChats)} from ${chats}` : ""}.`);
  }
  if (what === "gmail") { const gone = await d.store.forget(o.userId, ["gmail"]); await sweepsOf(d).forget(o.userId, ["correspondents"]); n += gone; parts.push(`Deleted ${plural(gone, "person")} read from your Gmail.`); }
  if (what === "all") await sweepsOf(d).forget(o.userId, ["correspondents"]);
  if (what === "jobs") { const gone = await d.store.forgetJobs(o.userId); await sweepsOf(d).forget(o.userId, ["job_alerts"]); n += gone; parts.push(`Deleted ${plural(gone, "posting")} read from your Handshake and Indeed emails.`); }
  if (what === "intros" || what === "all") { const gone = await d.store.forgetIntros(o.userId); n += gone; parts.push(`Deleted ${plural(gone, "intro request")}.`); }
  if (what === "linkedin") { const left = d.store.tallies ? (await d.store.tallies(o.userId, "")).intros_open : (await d.store.intros(o.userId)).filter((i) => i.status !== "cancelled").length; if (left) parts.push(`Your ${plural(left, "intro request")} ${left === 1 ? "is" : "are"} kept; say "forget my intro requests" to delete ${left === 1 ? "it" : "them"} too.`); }
  return { reply: n ? parts.join(" ") : `There was nothing to delete. ${parts.join(" ")}`.trim(), intent: FORGET_INTENT, status: n ? "forgotten" : "nothing" };
}

// ------------------------------------------------------------------------------------------------ introductions
const recipientOf = (p: PersonRec): Recipient => ({
  name: p.name ?? "", firm: p.company, title: p.position, school: p.school, email: p.email ?? "", source: p.source_ref,
  // the source of the row, for the certifier's recipientSourced (arch/networking-real-people)
  ...({ source_kind: kindOf(p.source), retrieved_at: p.retrieved_at || null, source_url: p.source_url } as Record<string, unknown>),
} as Recipient);
export type Path =
  | { route: "direct"; to: PersonRec }
  | { route: "mutual"; target: { name: string; company: string; title: string; ref: string; rec: PersonRec | null }; via: PersonRec; others: PersonRec[]; why: string }
  | { route: "none"; target: { name: string | null; company: string }; why: string };
// Pure: the way to someone. A direct contact first; else someone they know at the same firm (or, when the target's
// school is on file, the same school); else a route the target published (their address on a page they sent); else none.
export function pathTo(target: { name: string | null; firm: string | null }, everyone: PersonRec[]): Path {
  const firmKey = target.firm ? companyKey(target.firm) : "";
  const want = target.name ? plain(target.name) : "";
  const isTarget = (p: PersonRec) => !!want && !!p.name && (plain(p.name) === want || (!want.includes(" ") && plain(p.name).split(" ")[0] === want)) && (!firmKey || p.company_key === firmKey);
  const published = everyone.filter((p) => isTarget(p) && p.source === "company_page");
  const known = everyone.filter((p) => isTarget(p) && p.source !== "company_page");
  if (known.length) return { route: "direct", to: known.find((p) => p.email) ?? known[0] };
  if (!target.name) {
    const atFirm = everyone.filter((p) => p.company_key === firmKey && p.source !== "company_page");
    if (atFirm.length) return { route: "direct", to: rankVia(atFirm)[0] };
    const pub = everyone.filter((p) => p.company_key === firmKey && p.source === "company_page" && p.name);
    return { route: "none", target: { name: null, company: target.firm ?? "" }, why: pub.length ? `nobody you know is at ${target.firm}; ${target.firm}'s page names ${pub.slice(0, 5).map((p) => p.name).join(", ")}, so ask for one of them by name` : `nobody you know is at ${target.firm}` };
  }
  const t = published[0] ?? null;
  const tFirm = t?.company_key || firmKey;
  const colleagues = rankVia(everyone.filter((p) => p.source !== "company_page" && !!tFirm && p.company_key === tFirm && !isTarget(p)));
  const classmates = t?.school ? rankVia(everyone.filter((p) => p.source !== "company_page" && !!p.school && schoolMatch(p.school, t.school))) : [];
  const via = colleagues[0] ?? classmates[0];
  const company = t?.company || target.firm || "";
  if (via) return { route: "mutual", target: { name: t?.name ?? target.name, company, title: t?.position ?? "", ref: t ? t.source_ref : "you named them", rec: t }, via, others: [...colleagues, ...classmates].filter((p) => p !== via).slice(0, 2), why: colleagues[0] ? `also at ${company}` : `also went to ${t!.school}` };
  if (t?.email) return { route: "direct", to: t };
  return { route: "none", target: { name: target.name, company }, why: t ? `${t.source_url} names ${t.name} but publishes no address for them, nobody you know is at ${company || "their firm"}, and I never guess an email` : `nobody you know is at ${company || "their firm"}, and I have no address ${target.name} published` };
}
function rankVia(ps: PersonRec[]): PersonRec[] {
  const score = (p: PersonRec) => (p.email ? 4 : 0) + (p.source === "gmail" ? 2 : 0) + (p.connected_on ? Date.parse(p.connected_on) / 1e13 : 0);
  return [...ps].sort((a, b) => score(b) - score(a));
}
const introHash = (i: { to_email: string | null; to_name: string; subject: string; body: string; blurb: string | null }) =>
  sha256Hex(JSON.stringify([i.to_email ?? i.to_name, i.subject, i.body, i.blurb ?? ""]));
function mailto(i: Intro): string {
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  return `mailto:${encodeURIComponent(i.to_email!)}?subject=${enc(i.subject)}&body=${enc(fullText(i))}`;
}
const fullText = (i: Pick<Intro, "body" | "blurb" | "target_name">) => i.blurb ? `${i.body}\n\n---\nA note you can forward to ${i.target_name}:\n\n${i.blurb}` : i.body;
const howSent = (i: Intro) => i.delivery === "mailto" ? `opens in your email app, addressed to ${i.to_email}` : `to copy and send to ${i.to_name} yourself (a LinkedIn message, a text, however you reach them; I don't open LinkedIn)`;
function introCard(i: Intro, head: string): string {
  return [head, `To: ${i.to_name}${i.to_email ? ` <${i.to_email}>` : ""}`, `Subject: ${i.subject}`, "", i.body,
    ...(i.blurb ? ["", `--- A note ${i.to_name.split(" ")[0]} can forward to ${i.target_name} as is ---`, "", i.blurb] : []), "",
    `I don't send anything. Say "approve intro ${i.n}" and I'll give you the final text${i.delivery === "mailto" ? " and a link that opens it in your email app" : " to send yourself"}; "redo intro ${i.n}" for another version; "cancel intro ${i.n}" to drop it.`].join("\n");
}

async function introTurn(o: PeopleTurnIn, d: PeopleDeps, a: Extract<Ask, { kind: "intro" }>): Promise<PeopleResult> {
  const firm = a.firm ? cleanCell(a.firm, 60) : null;
  const pool: PersonRec[] = [];
  if (firm) pool.push(...(await everyoneAt(o, d, firm)).people, ...(await d.store.atCompany(o.userId, companyKey(firm))).filter((p) => p.source === "company_page"));
  if (a.name) pool.push(...await d.store.named(o.userId, a.name), ...stateRows(o).filter((p) => p.name && plain(p.name).startsWith(plain(a.name!))));
  // the target's colleagues, when we learn the target's firm from a page they published
  const pub = pool.find((p) => p.source === "company_page" && a.name && p.name && plain(p.name) === plain(a.name));
  if (pub && !firm && pub.company_key) pool.push(...await d.store.atCompany(o.userId, pub.company_key), ...stateRows(o).filter((p) => p.company_key === pub.company_key));
  const everyone = uniq(pool);
  const counts = await d.store.counts(o.userId);
  if (!everyone.length && !Object.values(counts).some(Boolean) && !stateRows(o).length) {
    return { reply: `I can't find a path to ${a.name ?? `someone at ${firm}`} yet: you haven't sent me any contacts. ${NO_FINDER} ${await askForExport(o, d)}`, intent: INTRO_INTENT, status: "no_contacts" };
  }
  const path = pathTo({ name: a.name, firm }, everyone);
  if (path.route === "none") return { reply: `No path to ${path.target.name ?? `someone at ${path.target.company}`} yet: ${path.why}. ${NO_FINDER} ${NO_SEARCH} If ${path.target.company || "their company"} or ${path.target.name ?? "they"} publish a team page or a personal site, send me the link and I'll read who it names and how to reach them.`, intent: INTRO_INTENT, status: "no_path" };
  const facts = confirmed((((o.state.profile as any)?.facts) ?? []) as unknown[]);
  const plan = path.route === "mutual"
    ? `ask ${path.via.name} (${fromWhere(path.via)}; ${path.why}) to introduce you to ${path.target.name}${path.target.company ? ` at ${path.target.company}` : ""}${path.others.length ? `; others who could: ${path.others.map((p) => p.name).join(", ")}` : ""}`
    : `write to ${path.to.name ?? path.to.email} directly (${fromWhere(path.to)})`;
  if (!facts.length) return { reply: `The path: ${plan}. I write only from facts you've confirmed, and there are none on record yet, so nothing was drafted. Paste your resume here and confirm it, then ask again.`, intent: INTRO_INTENT, status: "no_facts" };
  if (!o.model) return { reply: `The path: ${plan}. Drafting isn't switched on here yet, so nothing was written or sent.`, intent: INTRO_INTENT, status: "drafting_off" };
  // A retry of the same ask (a double tap) shows the draft already made: no second row, no second model call.
  const toName = path.route === "mutual" ? (path.via.name ?? path.via.email) : (path.to.name ?? path.to.email);
  const targetName = path.route === "mutual" ? path.target.name : toName;
  const recent = (await d.store.intros(o.userId)).find((i) => i.status === "drafted" && i.to_name === toName && i.target_name === targetName && o.now - Date.parse(i.created_at) < 120_000);
  if (recent) return { reply: introCard(recent, `Intro ${recent.n} is already drafted:`), intent: INTRO_INTENT, status: "drafted" };
  return await draftIntro(o, d, path, a.topic, null);
}

// PERSONALIZED OUTREACH (2026-10-31): what the person told Trainee about this recipient (career_networking.ts saveFacts),
// by the same person key the contacts use.
const keyOf = (r: Recipient) => personKey({ email: r.email || null, name: r.name, firm: r.firm } as any);
async function withFacts(o: PeopleTurnIn, r: Recipient): Promise<Recipient> {
  if (!o.store.recipientFacts) return r;
  const got = (await o.store.recipientFacts(o.userId, [keyOf(r)]).catch(() => new Map())).get(keyOf(r)) ?? [];
  return got.length ? { ...r, facts: [...(r.facts ?? []), ...got] } : r;
}
// Nothing specific about them: the one question; the person's answer is saved on them and this same ask runs again.
async function askFirst(o: PeopleTurnIn, r: Recipient, topic: string | null): Promise<PeopleResult> {
  await setFactAsk(o, { key: keyOf(r), name: r.name, firm: r.firm, email: r.email || null, topic, replay: o.message, at: new Date(o.now).toISOString() });
  return { reply: factQuestion(r), intent: FACTS_INTENT, status: "needs_facts" };
}
async function draftIntro(o: PeopleTurnIn, d: PeopleDeps, path: Exclude<Path, { route: "none" }>, topic: string | null, previous: Intro | null): Promise<PeopleResult> {
  const facts = (((o.state.profile as any)?.facts) ?? []) as unknown[];
  const sig = (await o.store.prefs(o.userId).catch(() => ({ signature: null } as any)))?.signature as string | null;
  const signed = (b: string) => sig ? `${b.trim()}\n\n${sig.trim()}` : b.trim();
  let row: Parameters<PeopleStore["addIntro"]>[1];
  if (path.route === "mutual") {
    const via = recipientOf(path.via);
    const target: Recipient = await withFacts(o, path.target.rec ? recipientOf(path.target.rec) : { name: path.target.name, firm: path.target.company, title: path.target.title, school: "", email: "", source: path.target.ref });
    const ask = `an introduction to ${path.target.name}${path.target.title ? `, ${path.target.title}` : ""}${path.target.company ? ` at ${path.target.company}` : ""}${topic ? `, to ask about ${topic}` : ""}; short, easy to say no to, and mention a note is below that they can forward`;
    const [req, blurb] = await Promise.all([
      // The request to someone they already know, carrying the note below: the note is the first email to the target.
      draftFor({ model: o.model!, facts, r: via, topic: ask, previous: previous?.body ?? null, personal: false }),
      draftFor({ model: o.model!, facts, r: target, topic: topic ?? `a short conversation about their work${path.target.company ? ` at ${path.target.company}` : ""}`, previous: previous?.blurb ?? null }),
    ]);
    const bad = [!req.ok ? `the request to ${via.name}: ${req.why === "unverified" ? `it said something not on record (${req.detail.slice(0, 2).join("; ")})` : req.why === "model" ? "the writing model didn't answer" : req.detail.join("; ")}` : "",
      !blurb.ok ? `the note for ${target.name}: ${blurb.why === "unverified" ? `it said something not on record (${blurb.detail.slice(0, 2).join("; ")})` : blurb.why === "model" ? "the writing model didn't answer" : blurb.detail.join("; ")}` : ""].filter(Boolean);
    if (!blurb.ok && blurb.why === "unsourced") return await askFirst(o, target, topic);
    if (!req.ok || !blurb.ok) return { reply: `Nothing was drafted: ${bad.join("; ")}.`, intent: INTRO_INTENT, status: "not_drafted" };
    row = { route: "mutual", target_name: path.target.name, target_company: path.target.company, target_title: path.target.title, target_ref: path.target.ref.slice(0, 600),
      via_name: path.via.name ?? path.via.email, via_ref: `${fromWhere(path.via)}`.slice(0, 600), to_name: (path.via.name ?? path.via.email)!, to_email: path.via.email,
      delivery: path.via.email ? "mailto" : "copy", subject: req.subject.slice(0, 200), body: signed(req.body).slice(0, 3000), blurb: blurb.body.trim().slice(0, 3000), payload_hash: "" };
  } else {
    const to = await withFacts(o, recipientOf(path.to));
    const r = await draftFor({ model: o.model!, facts, r: to, topic, previous: previous?.body ?? null });
    if (!r.ok && r.why === "unsourced") return await askFirst(o, to, topic);
    if (!r.ok) return { reply: `Nothing was drafted: ${r.why === "unverified" ? `it said something not on record (${r.detail.slice(0, 2).join("; ")})` : r.why === "model" ? "the writing model didn't answer" : r.detail.join("; ")}.`, intent: INTRO_INTENT, status: "not_drafted" };
    row = { route: "direct", target_name: (path.to.name ?? path.to.email)!, target_company: path.to.company, target_title: path.to.position, target_ref: fromWhere(path.to).slice(0, 600),
      via_name: null, via_ref: null, to_name: (path.to.name ?? path.to.email)!, to_email: path.to.email, delivery: path.to.email ? "mailto" : "copy",
      subject: r.subject.slice(0, 200), body: signed(r.body).slice(0, 3000), blurb: null, payload_hash: "" };
  }
  row.payload_hash = await introHash(row);
  let saved: Intro;
  if (previous) {
    const u = await d.store.updateIntro(o.userId, previous.n, { subject: row.subject, body: row.body, blurb: row.blurb, payload_hash: row.payload_hash, approved_hash: null, approved_at: null, status: "drafted" }, { status: ["drafted", "approved"] });
    if (!u) return { reply: `Intro ${previous.n} changed while I was rewriting it, so I left it as it was.`, intent: INTRO_UPDATE_INTENT, status: "refused" };
    saved = u;
  } else saved = await d.store.addIntro(o.userId, row);
  const head = path.route === "mutual"
    ? `Intro ${saved.n}: ask ${saved.to_name} (${saved.via_ref}) to introduce you to ${saved.target_name}${saved.target_company ? ` at ${saved.target_company}` : ""}.`
    : `Intro ${saved.n}: a note straight to ${saved.to_name} (${saved.target_ref}).`;
  return { reply: introCard(saved, head), intent: INTRO_INTENT, status: "drafted" };
}

async function introCmd(o: PeopleTurnIn, d: PeopleDeps, a: Extract<Ask, { kind: "intro_cmd" }>): Promise<PeopleResult> {
  // A numbered intro is read by its number (one row, on the (user_id, n) key), however old; "the last one" from the
  // newest page.
  const n = a.n ?? (await d.store.intros(o.userId)).filter((i) => i.status !== "cancelled").at(-1)?.n ?? null;
  const i = n === null ? null : await d.store.intro(o.userId, n);
  const R = (reply: string, status: string) => ({ reply, intent: INTRO_UPDATE_INTENT, status });
  if (!i) return R(n === null ? "You have no intro requests yet." : `There's no intro ${n} on your list. Say "my intros" to see them.`, "not_found");
  if (i.status === "cancelled" && a.verb !== "cancel") return R(`Intro ${i.n} was cancelled, so I left it as it is.`, "refused");
  const iso = new Date(o.now).toISOString();
  switch (a.verb) {
    case "approve": {
      if (["sent", "replied", "no_reply"].includes(i.status)) return R(`Intro ${i.n} is already marked ${i.status.replace("_", " ")}.`, "refused");
      // The exact text: what is stored must still hash to what was shown, or nothing is approved.
      if ((await introHash(i)) !== i.payload_hash) return R(`Intro ${i.n} doesn't match what I showed you, so I didn't approve it. Say "redo intro ${i.n}" for a fresh version.`, "refused");
      const u = i.status === "approved" ? i : await d.store.updateIntro(o.userId, i.n, { status: "approved", approved_hash: i.payload_hash, approved_at: iso }, { status: ["drafted"], payload_hash: i.payload_hash });
      if (!u) return R(`Intro ${i.n} changed before your approval landed, so nothing was approved. Say "my intros" to see it as it is now.`, "refused");
      return R([`Approved intro ${u.n}, exactly as shown. I don't send it: here it is ${howSent(u)}.`, "", `To: ${u.to_name}${u.to_email ? ` <${u.to_email}>` : ""}`, `Subject: ${u.subject}`, "", fullText(u),
        ...(u.delivery === "mailto" ? ["", mailto(u)] : []), "", `When you've sent it, say "intro ${u.n} sent". If you'd like a nudge when there's no reply, say "remind me in 5 days".`].join("\n"), "approved");
    }
    case "redo": {
      if (!["drafted", "approved"].includes(i.status)) return R(`Intro ${i.n} is already ${i.status.replace("_", " ")}, so I left it as it is.`, "refused");
      if (!o.model) return R("Drafting isn't switched on here yet, so nothing was rewritten.", "drafting_off");
      const everyone = uniq([...await d.store.named(o.userId, i.to_name), ...await d.store.named(o.userId, i.target_name), ...stateRows(o)]);
      const toRec = everyone.find((p) => p.name === i.to_name && (!i.to_email || p.email === i.to_email));
      if (!toRec) return R(`${i.to_name} is no longer in your contacts, so I can't rewrite intro ${i.n}.`, "refused");
      const tRec = everyone.find((p) => p.name === i.target_name && p.source === "company_page") ?? null;
      const path: Exclude<Path, { route: "none" }> = i.route === "mutual"
        ? { route: "mutual", target: { name: i.target_name, company: i.target_company, title: i.target_title, ref: i.target_ref, rec: tRec }, via: toRec, others: [], why: "" }
        : { route: "direct", to: toRec };
      return await draftIntro(o, d, path, null, i);
    }
    case "cancel": {
      if (i.status === "cancelled") return R(`Intro ${i.n} is already cancelled.`, "cancelled");
      await d.store.updateIntro(o.userId, i.n, { status: "cancelled", follow_up_at: null });
      return R(`Cancelled intro ${i.n}${i.status === "sent" ? " (you'd already sent it, so this only stops my tracking and reminders)" : ""}.`, "cancelled");
    }
    case "sent": {
      if (i.status === "sent") return R(`Intro ${i.n} is already marked sent (${day(i.sent_at)}).`, "sent");
      if (["replied", "no_reply"].includes(i.status)) return R(`Intro ${i.n} is already marked ${i.status.replace("_", " ")}.`, "refused");
      const u = await d.store.updateIntro(o.userId, i.n, { status: "sent", sent_at: iso, status_source: "person" }, { status: ["drafted", "approved"] });
      return R(u ? `Marked intro ${i.n} sent (${day(iso)}). Say "intro ${i.n} replied" or "intro ${i.n} no reply" when you know, or "remind me in 5 days" if you'd like a nudge.` : `Intro ${i.n} changed, so I left it as it is.`, u ? "sent" : "refused");
    }
    case "replied": case "no_reply": {
      if (!["sent", "replied", "no_reply"].includes(i.status)) return R(`Intro ${i.n} isn't marked sent yet. Say "intro ${i.n} sent" first.`, "refused");
      await d.store.updateIntro(o.userId, i.n, { status: a.verb, status_source: "person", follow_up_at: null });
      return R(a.verb === "replied" ? `Marked intro ${i.n} replied. Good luck with ${i.target_name}.` : `Marked intro ${i.n} as no reply.${i.route === "mutual" ? ` Say "get me an intro to ${i.target_name}${i.target_company ? ` at ${i.target_company}` : ""}" to try someone else.` : ""}`, a.verb);
    }
    case "remind": {
      if (!["approved", "sent"].includes(i.status)) return R(`Intro ${i.n} is ${i.status.replace("_", " ")}, so there's nothing to follow up on.`, "refused");
      const due = new Date((i.sent_at ? Date.parse(i.sent_at) : o.now) + a.days! * 86400_000).toISOString();
      await d.store.updateIntro(o.userId, i.n, { follow_up_days: a.days!, follow_up_at: due, reminded_at: null });
      // The words follow what the code does: with the push on (the same flag the scheduled run is wired by) AND a texting
      // channel on record for them, the reminder is queued for delivery to that channel at its date. Otherwise it can
      // only be brought up in this chat, and the reply says so, and why when the only thing missing is their channel.
      const texted = d.introPush && d.canText ? await d.canText(o.userId) : false;
      return R(texted
        ? `OK: if there's no reply to intro ${i.n} by ${day(due)}, I'll text you a reminder then; if you message me first, I'll bring it up here.`
        : d.introPush
        ? `OK: if there's no reply to intro ${i.n} by ${day(due)}, I'll bring it up the next time you message me after that. I can only message you first by text, and you haven't connected a texting app.`
        : `OK: if there's no reply to intro ${i.n} by ${day(due)}, I'll bring it up the next time you message me after that. I can't message you first yet.`, "reminder_set");
    }
  }
}

// The reminder's words, one composer for both surfaces: shown in this chat at the person's next message (dueLine),
// and queued to the outbox by the scheduled push (career_people_reminders.ts) — the same text either way, and never
// the note itself: an introduction is only ever the person's to send (D-033).
export function introReminderText(due: Intro[]): string {
  return `Reminder you asked for: ${due.map((i) => `intro ${i.n} to ${i.to_name}${i.route === "mutual" ? ` (for ${i.target_name})` : ""}, sent ${day(i.sent_at) || "earlier"}`).join("; ")} has no reply on record. Say "intro ${due[0].n} replied", "intro ${due[0].n} no reply", or "redo intro ${due[0].n}".`;
}
async function dueLine(o: PeopleTurnIn, d: PeopleDeps): Promise<string> {
  const due = d.store.dueFor ? await d.store.dueFor(o.userId, new Date(o.now).toISOString())
    : (await d.store.intros(o.userId)).filter((i) => i.follow_up_at && !i.reminded_at && ["approved", "sent"].includes(i.status) && Date.parse(i.follow_up_at) <= o.now);
  if (!due.length) return "";
  for (const i of due) await d.store.updateIntro(o.userId, i.n, { reminded_at: new Date(o.now).toISOString() });
  return introReminderText(due);
}
async function introList(o: PeopleTurnIn, d: PeopleDeps): Promise<PeopleResult> {
  const due = await dueLine(o, d);
  let all = await d.store.intros(o.userId);
  if (!all.length) return { reply: `You have no intro requests yet. Say "get me an intro to <name> at <company>".`, intent: INTRO_LIST_INTENT, status: "none" };
  // Gmail, where connected: a reply from the person written to, after the day it was sent, marks it replied.
  if (d.gmail) {
    for (const i of all.filter((x) => x.status === "sent" && x.to_email && x.sent_at)) {
      if ((await heardFrom(d.gmail, o.userId, i.to_email!, Date.parse(i.sent_at!))) === "yes") await d.store.updateIntro(o.userId, i.n, { status: "replied", status_source: "gmail", follow_up_at: null });
    }
    all = await d.store.intros(o.userId);
  }
  const word = (i: Intro) => i.status === "replied" ? `replied${i.status_source === "gmail" ? " (Gmail shows a reply)" : " (you said)"}` : i.status === "no_reply" ? "no reply (you said)" : i.status === "sent" ? `sent ${day(i.sent_at)}${i.follow_up_at ? `, reminder ${day(i.follow_up_at)}` : ""}` : i.status;
  return {
    reply: [...(due ? [due, ""] : []), "Your intro requests:", ...all.map((i) => `${i.n}. ${i.route === "mutual" ? `via ${i.via_name} to ${i.target_name}` : `to ${i.to_name}`}${i.target_company ? ` (${i.target_company})` : ""}: ${word(i)}`)].join("\n"),
    intent: INTRO_LIST_INTENT, status: "listed",
  };
}
