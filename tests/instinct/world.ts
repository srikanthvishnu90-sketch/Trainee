// Instinct harness: the world a brand-new user meets. One throwaway Postgres 16 with CI's migration order
// (tests/flow/pg.ts), Supabase's HTTP surface answered over it (tests/flow/postgrest.ts, plus GoTrue's admin create here),
// every deployed edge function loaded from its own index.ts (serve captured: tests/instinct/serve-capture.ts) and reached
// at /functions/v1/<name> exactly as the platform routes it, every outside system faked at its HTTP boundary
// (tests/instinct/fakes.ts), and the employers as real pages on 127.0.0.1 (tests/instinct/employers.ts).
//
// Any request to a host that is not faked is refused and recorded in `unexpected`: a scenario that reached a real host
// fails. Nothing here sends anything to anyone.
//
// The two things that run outside an edge function in production run here as their own processes would run them:
//   prepare  workers/career-browser/prepare-ahead.ts prepareAhead (the engine's dry run in a real Chromium)
//   drive    workers/career-browser/approve-first.ts runApproved over the person's own queue (career_apply_claim_own),
//            the engine submitting in a real Chromium on the person's computer
// deno-lint-ignore-file no-explicit-any
import { type Pg, pgBinDir, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { ANON_KEY, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type Fake, fakeGoogle, fakeLoop, fakeMicrosoft, fakeOpenAI, fakeProvider, fakeTelegram, fakeWhatsApp, readHit } from "./fakes.ts";
import { employers as startEmployers, type Posting } from "./employers.ts";

export { ANON_KEY, SERVICE_KEY, SUPABASE_URL };
export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const g = globalThis as any;

export const SECRETS = {
  inbound: "INSTINCT-inbound-secret-0123456789abcdefghij",
  tgToken: "123456:INSTINCT-not-a-real-bot-token",
  tgSecret: "INSTINCT_tg_webhook_secret_0123456789_abcdef",
  waToken: "INSTINCT-wa-token-not-real", waPnid: "100200300400", waApp: "INSTINCT-wa-app-secret-not-real", waVerify: "INSTINCT-wa-verify-0123456789abcdefghijkl",
  deliver: "INSTINCT-deliver-secret-0123456789abcdefghij",
  proactive: "INSTINCT-proactive-secret-0123456789abcdefgh",
  oauthState: "INSTINCT-oauth-state-secret-0123456789abcdef",
  providerKey: "INSTINCT-provider-key-not-real",
};

export interface FnCall { name: string; method: string; status: number; ms: number; at: number }

export async function makeWorld(o: { postings: Posting[] }) {
  if (!pgBinDir()) throw new Error("Instinct needs Postgres 16 server binaries (PGBIN or /usr/lib/postgresql/16/bin)");
  const t0 = performance.now();
  const pg: Pg = await startPg();
  await supabaseParity(pg);
  const provisionMs = Math.round(performance.now() - t0);
  const users: Record<string, { id: string; email?: string }> = {};
  const double = postgrestDouble(pg, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users });

  const env: Record<string, string> = {
    SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    TRAINEE_SIGNUP: "open",
    TRAINEE_INBOUND_SECRET: SECRETS.inbound, LOOPMESSAGE_API_KEY: "INSTINCT-loop-key-not-real",
    TELEGRAM_BOT_TOKEN: SECRETS.tgToken, TELEGRAM_WEBHOOK_SECRET: SECRETS.tgSecret, TELEGRAM_BOT_USERNAME: "InstinctTestBot",
    WHATSAPP_TOKEN: SECRETS.waToken, WHATSAPP_PHONE_NUMBER_ID: SECRETS.waPnid, WHATSAPP_APP_SECRET: SECRETS.waApp, WHATSAPP_VERIFY_TOKEN: SECRETS.waVerify,
    TRAINEE_DELIVER_SECRET: SECRETS.deliver, CAREER_PROACTIVE_SECRET: SECRETS.proactive,
    GOOGLE_OAUTH_CLIENT_ID: "instinct-google-client.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "INSTINCT-google-secret-not-real",
    OAUTH_STATE_SECRET: SECRETS.oauthState,
    // Outlook: the names a Microsoft Graph connector is likely to read (none is wired on trunk).
    MICROSOFT_OAUTH_CLIENT_ID: "instinct-ms-client", MICROSOFT_OAUTH_CLIENT_SECRET: "INSTINCT-ms-secret-not-real",
    MS_OAUTH_CLIENT_ID: "instinct-ms-client", MS_OAUTH_CLIENT_SECRET: "INSTINCT-ms-secret-not-real",
    OUTLOOK_OAUTH_CLIENT_ID: "instinct-ms-client", OUTLOOK_OAUTH_CLIENT_SECRET: "INSTINCT-ms-secret-not-real",
    // A stand-in key value: the OpenAI host is answered by the scripted writer, never the real API (no model spend).
    OPENAI_API_KEY: "instinct-fake-openai-key-not-real", CAREER_MODEL: "gpt-5-mini",
    // The rails the owner turns on at go-live, on here so the scenarios reach them.
    CAREER_NETWORKING_DRAFT: "on", CAREER_OUTREACH_SEND: "on", CAREER_EMAIL_SEND: "on", CAREER_MAIL_TRACKING: "on",
    CAREER_INTRO_REMINDERS: "on",
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);

  const telegram = fakeTelegram(SECRETS.tgToken), whatsapp = fakeWhatsApp(SECRETS.waPnid), loop = fakeLoop();
  const google = fakeGoogle(), microsoft = fakeMicrosoft(), provider = fakeProvider(SECRETS.providerKey);
  const openai = fakeOpenAI({ invent: (p) => /- name: Sam\b/.test(p) });
  const fakes: Fake[] = [telegram, whatsapp, loop, google, microsoft, provider, openai];
  const byHost = new Map<string, Fake>();
  for (const f of fakes) for (const h of f.hosts) byHost.set(h, f);
  const unexpected: string[] = [];
  const fnCalls: FnCall[] = [];
  const missingFns = new Set<string>();

  const site = startEmployers(o.postings);

  // ---------------------------------------------------------------------------------------------- deployed functions
  const loaded = new Map<string, Promise<((req: Request) => Promise<Response>) | null>>();
  const fn = (name: string) => {
    if (!loaded.has(name)) {
      loaded.set(name, (async () => {
        // agent-chat deploys from index-career.ts (scripts/launch/trainee-go-live.sh: the career-only artifact).
        const rel = name === "agent-chat" ? "agent-chat/index-career.ts" : `${name}/index.ts`;
        const path = `${ROOT}/supabase/functions/${rel}`;
        try { Deno.statSync(path); } catch { missingFns.add(name); return null; }
        g.__instinctServe ??= [];
        const before = g.__instinctServe.length;
        const realServe = Deno.serve;
        (Deno as any).serve = (a: any, b?: any) => { g.__instinctServe.push(typeof a === "function" ? a : b ?? a?.handler); return { finished: Promise.resolve(), shutdown: async () => {}, addr: { port: 0 } }; };
        try { await import(`file://${path}`); } finally { (Deno as any).serve = realServe; }
        const h = g.__instinctServe[before];
        if (typeof h !== "function") throw new Error(`${rel} did not hand a handler to serve`);
        return async (req: Request) => await h(req);
      })());
    }
    return loaded.get(name)!;
  };

  // ---------------------------------------------------------------------------------------------- GoTrue's admin API
  const q = (v: string) => `$q${"x".repeat(3)}$${v}$q${"x".repeat(3)}$`;
  async function gotrue(req: Request): Promise<Response> {
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (tok !== SERVICE_KEY) return Response.json({ msg: "not the service role" }, { status: 403 });
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/auth/v1/admin/users") {
      const body = await req.json().catch(() => ({}));
      const email = typeof body?.email === "string" ? body.email : null, phone = typeof body?.phone === "string" && body.phone ? body.phone : null;
      // As Supabase Auth does (launch audit 2026-10-26): a user with neither an email nor a phone is refused.
      if (!email && !phone) return Response.json({ code: 422, error_code: "validation_failed", msg: "An email or a phone is required" }, { status: 422 });
      if (email && (await pg.sql(`select count(*) from auth.users where lower(email) = lower(${q(email)})`)) !== "0") {
        return Response.json({ code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" }, { status: 422 });
      }
      const id = (/[0-9a-f-]{36}/.exec(await pg.sql(`insert into auth.users (email) values (${email === null ? "null" : q(email)}) returning id`)) ?? [""])[0];
      return Response.json({ id, aud: "authenticated", role: "authenticated", email, phone, user_metadata: body?.user_metadata ?? {}, app_metadata: {}, created_at: new Date().toISOString() });
    }
    const one = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (one && req.method === "GET") {
      const email = await pg.sql(`select coalesce(email, '') from auth.users where id = '${one[1]}'`);
      return email === "" && (await pg.sql(`select count(*) from auth.users where id = '${one[1]}'`)) === "0" ? Response.json({ msg: "User not found" }, { status: 404 }) : Response.json({ id: one[1], email: email || null });
    }
    if (one && req.method === "DELETE") { await pg.sql(`delete from auth.users where id = '${one[1]}'`); return Response.json({}); }
    return Response.json({ msg: `instinct gotrue: unsupported ${req.method} ${u.pathname}` }, { status: 400 });
  }

  // ---------------------------------------------------------------------------------------------- Supabase Storage
  // The object routes storage-js 2.117.1 calls, over an in-memory bucket store; each upload is mirrored in storage.objects
  // (the stub's table) so the database sees the same files the product stored.
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  async function storage(req: Request): Promise<Response> {
    const u = new URL(req.url), p = u.pathname.replace(/^\/storage\/v1/, "");
    const sign = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (sign && req.method === "POST") return Response.json({ signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=instinct` });
    const list = /^\/object\/list\/([^/]+)$/.exec(p);
    if (list) { const b = await req.json().catch(() => ({})); const pre = `${list[1]}/${b?.prefix ?? ""}`; return Response.json([...objects.keys()].filter((k) => k.startsWith(pre)).map((k) => ({ name: k.slice(pre.length).replace(/^\//, "") }))); }
    const bucketOnly = /^\/object\/([^/]+)$/.exec(p);
    if (bucketOnly && req.method === "DELETE") {
      const b = await req.json().catch(() => ({}));
      for (const x of b?.prefixes ?? []) { objects.delete(`${bucketOnly[1]}/${x}`); await pg.sql(`delete from storage.objects where bucket_id = ${q(bucketOnly[1])} and name = ${q(String(x))}`).catch(() => {}); }
      return Response.json((b?.prefixes ?? []).map((name: string) => ({ name })));
    }
    const obj = /^\/object\/(?:authenticated\/|public\/|sign\/)?([^/]+)\/(.+)$/.exec(p);
    if (obj && (req.method === "POST" || req.method === "PUT")) {
      objects.set(`${obj[1]}/${obj[2]}`, { bytes: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("content-type") ?? "application/octet-stream" });
      await pg.sql(`insert into storage.objects (bucket_id, name) values (${q(obj[1])}, ${q(obj[2])}) on conflict (bucket_id, name) do nothing`).catch(() => {});
      return Response.json({ Key: `${obj[1]}/${obj[2]}`, path: obj[2] });
    }
    if (obj && req.method === "GET") {
      const o2 = objects.get(`${obj[1]}/${obj[2]}`);
      return o2 ? new Response(o2.bytes as BodyInit, { headers: { "content-type": o2.type } }) : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 404 });
    }
    return Response.json({ message: `instinct storage: unsupported ${req.method} ${p}` }, { status: 400 });
  }

  // ---------------------------------------------------------------------------------------------- the network
  const realFetch = globalThis.fetch.bind(globalThis);
  const route = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.origin === SUPABASE_URL) {
      const f = /^\/functions\/v1\/([a-z0-9-]+)/.exec(u.pathname);
      if (f) {
        const h = await fn(f[1]);
        if (!h) return Response.json({ error: `instinct: no function ${f[1]} in this tree` }, { status: 404 });
        const s = performance.now();
        const res = await h(req);
        fnCalls.push({ name: f[1], method: req.method, status: res.status, ms: Math.round(performance.now() - s), at: Date.now() });
        return res;
      }
      if (u.pathname.startsWith("/auth/v1/admin/")) return await gotrue(req);
      if (u.pathname.startsWith("/storage/v1/")) return await storage(req);
      return await double.fetch(req);
    }
    if (/^(127\.\d+\.\d+\.\d+|localhost)$/.test(u.hostname)) return await realFetch(req);
    const fake = byHost.get(u.hostname);
    if (fake) {
      const hit = await readHit(req);
      fake.log.push(hit);
      return await fake.handle(req, hit);
    }
    unexpected.push(`${req.method} ${u.origin}${u.pathname}`);
    throw new TypeError(`instinct: ${u.host} is not reachable from the harness (nothing real is ever contacted)`);
  };
  globalThis.fetch = route as typeof fetch;

  // A request to a deployed function, as the platform delivers it.
  const call = async (name: string, init: RequestInit & { path?: string } = {}) => {
    const res = await route(`${SUPABASE_URL}/functions/v1/${name}${init.path ?? ""}`, init);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  };

  // ---------------------------------------------------------------------------------------------- reading state
  const rows = async (sql: string): Promise<any[]> => JSON.parse(await pg.sql(`select coalesce(json_agg(x), '[]') from (${sql}) x`));
  const one = async (sql: string): Promise<string> => await pg.sql(sql);
  const exists = async (rel: string) => (await pg.sql(`select to_regclass('public.${rel}') is not null`)) === "t";
  const fnExists = async (name: string) => (await pg.sql(`select count(*) from pg_proc where proname = '${name}' and pronamespace = 'public'::regnamespace`)) !== "0";

  // ---------------------------------------------------------------------------------------------- setup helpers
  // Web sign-up is Supabase Auth's (the app's sign-in), not Trainee's code: the account and its token, as setup.
  const signUpWeb = async (email: string) => {
    const id = (/[0-9a-f-]{36}/.exec(await pg.sql(`insert into auth.users (email) values (${q(email)}) returning id`)) ?? [""])[0];
    const token = `tok-${id}`;
    users[token] = { id, email };
    return { id, token };
  };
  const seedPostings = async (ps: Posting[], o2: { postedHoursAgo?: (i: number) => number } = {}) => {
    site.add(ps.filter((p) => !site.postings.includes(p)));
    const desc = "TEST synthetic posting. Software engineering internship: build backend services in Python and TypeScript, write tests, ship weekly. Remote in the US.";
    for (let i = 0; i < ps.length; i += 100) {
      const part = ps.slice(i, i + 100);
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${part.map((p) => `(${q(p.key)}, '${p.ats}', ${q(p.board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.publicUrl)}, ${q(desc)}, now(), now())`).join(",")}
        on conflict do nothing;
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${part.map((p, k) => `(${q(p.key)}, '${p.ats}', ${q(p.board)}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.publicUrl)}, now() - interval '${(o2.postedHoursAgo?.(i + k) ?? (i + k) % 48)} hours', ${q(desc)}, ${q(`h-${p.key}`)})`).join(",")}
        on conflict do nothing;`);
    }
  };

  return {
    pg, double, users, env, fakes: { telegram, whatsapp, loop, google, microsoft, provider, openai }, unexpected, fnCalls, missingFns, site,
    provisionMs, call, fn, rows, one, exists, fnExists, signUpWeb, seedPostings, q,
    async stop() {
      globalThis.fetch = realFetch;
      await site.close();
      await pg.stop();
    },
  };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
