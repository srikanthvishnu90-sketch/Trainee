// Response-loop world (agent2/responses, 2026-11-09): one throwaway Postgres with every migration, the real career handler
// (tests/flow/handler.ts: handler-career.ts handleChat over supabase-js and the PostgREST double), a small posting board, and
// people who either have a confirmed resume on file or not. No model key is set, so every reply is the code's own words (the
// router, the _shared handlers and their templates): exactly the text the response sweep has to score. Every host but the
// Supabase double is refused and recorded.
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity, type Turn } from "../../flow/handler.ts";
import { confirmedResumeSql } from "../../flow/resume-seed.ts";

export const CI = Deno.env.get("CI") === "true";
export const ZONE = "America/Chicago";
const lit = (s: string) => `$q$${s}$q$`;

export const BOARD = [
  { id: "greenhouse:rw:lakefront-da", company: "Lakefront Transit Analytics", title: "Data Analyst Intern", location: "Chicago, IL", text: "Summer internship. SQL, Python, dashboards. Students graduating December 2027 or later." },
  { id: "greenhouse:rw:prairie-ba", company: "Prairie Ledger", title: "Business Analyst Intern", location: "Remote, US", text: "Remote internship. Excel, SQL, stakeholder reporting." },
  { id: "greenhouse:rw:northline-da", company: "Northline Health Data", title: "Data Analyst Intern", location: "Evanston, IL", text: "Health data analytics internship. SQL and Tableau." },
  { id: "greenhouse:rw:contoso-mkt", company: "Contoso", title: "Marketing Coordinator", location: "Austin, TX", text: "Campaign coordination." },
];

const ENV_KEYS = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND",
  "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS",
  "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL",
  "CAREER_NETWORKING_DRAFT", "CAREER_PEOPLE_SEARCH", "STRIPE_SECRET_KEY"];

export interface World {
  pg: Pg;
  outbound: string[];
  // A fresh person (own token, own thread). resume: a confirmed resume is on file before the first turn.
  person(opts?: { resume?: boolean }): Promise<{ id: string; chat: Chat; say: (m: string) => Promise<Turn> }>;
  close(): Promise<void>;
}

export function canRun(): string | null {
  if (!pgBinDir()) return CI ? "FAIL" : "NOT_RUN locally: no Postgres binaries";
  if (Deno.uid?.() === 0 && !CI) return "NOT_RUN locally as root: run it as an unprivileged user (initdb)";
  return null;
}

// model: answers requests to the Anthropic host (a scripted model for the staged brain); without it that host is refused too.
export async function openWorld(people = 64, opts: { model?: (req: Request) => Promise<Response> | Response } = {}): Promise<World> {
  const pg = await startPg();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  Deno.env.set("CAREER_MAIL_TRACKING", "off"); // D-036: a release flag; mail paths stay off only with "off"
  const ids = Array.from({ length: people }, (_, i) => `7b0f8f8e-6a43-4a49-9d2c-0000a2${String(i).padStart(6, "0")}`);
  const tokens = Object.fromEntries(ids.map((p, i) => [`tok-rw-${i}`, p]));
  const realFetch = globalThis.fetch, realError = console.error, realLog = console.log;
  await supabaseParity(pg);
  const vals = ids.map((p) => `('${p}')`).join(", ");
  await pg.sql(`insert into auth.users (id, email) select id::uuid, id || '@example.test' from (values ${vals}) v(id);
    insert into public.profiles (id) select id::uuid from (values ${vals}) v(id);
    insert into public.career_watch_kv (user_id, key, value) select id::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from (values ${vals}) v(id);
    -- Each person's time zone is known (R7: times in the person's own zone). Alerts stay off.
    insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) select id::uuid, '${ZONE}',
      '{"on":false,"keywords":["data analyst"],"locations":[],"remote_ok":true,"report_hour":"9","quiet_start":"22","quiet_end":"7","max_instant_per_day":"3"}', now() from (values ${vals}) v(id);
    insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${BOARD.map((b) => `(${lit(b.id)}, 'greenhouse', 'rw', ${lit(b.company)}, ${lit(b.title)}, ${lit(b.location)}, ${lit(`https://boards.greenhouse.io/rw/jobs/${b.id.split(":")[2]}`)}, ${lit(b.text)}, now() - interval '2 days', now())`).join(",\n")};`);
  const h = await careerHandler(pg, tokens);
  const viaDouble = globalThis.fetch, outbound: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (opts.model && u.host === "api.anthropic.com") return await opts.model(req);
    if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
    return await viaDouble(req);
  }) as typeof fetch;
  if (!Deno.env.get("RW_DEBUG")) console.error = () => {};
  console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].startsWith("{\"evt\"")) return; realLog(...a); };
  let next = 0;
  return {
    pg,
    outbound,
    async person(opts = {}) {
      const i = next++;
      if (i >= ids.length) throw new Error("response world: out of people");
      if (opts.resume) await pg.sql(confirmedResumeSql(ids[i]));
      const chat = h.chat(`tok-rw-${i}`);
      const say = async (m: string) => { await pg.sql(`delete from public.agent_rate_limits`); return await chat.say(m); };
      return { id: ids[i], chat, say };
    },
    async close() {
      globalThis.fetch = realFetch;
      console.error = realError;
      console.log = realLog;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h.restore();
      await pg.stop();
    },
  };
}
