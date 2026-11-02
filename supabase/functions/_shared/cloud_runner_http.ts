// career-cloud-runner's routes (docs/launch/CLOUD-RUNNER.md), as one handler the edge function serves and the tests drive:
//   POST /dispatch            the send tick (pg_cron, every minute), header x-cloud-dispatch-secret
//   POST /job/<op>            one send sandbox, for its one job (job, sources, authorize, resume, ask, finish), its token
//   POST /prepare             FEATURE 17: the chat's kick (agent-chat kickPrepare), Authorization: Bearer CAREER_PREPARE_AHEAD_TOKEN
//   POST /prepare-dispatch    FEATURE 17: the preparation tick (pg_cron, every minute), header x-cloud-dispatch-secret
//   POST /prep/<op>           FEATURE 17: one preparation sandbox, for its one request (request, rpc, resume, finish), its token
// Sending is off unless CLOUD_RUNNER_ENABLED=on, preparation unless CLOUD_PREPARE_ENABLED=on; the database's own switches
// (CAREER_CLOUD_APPLY, CAREER_CLOUD_TEXT_CARDS) and every cap still decide each claim. Secrets are read by name only.
import { dispatch, handleBridge, type ClaimedJob, type Rpc, type SandboxHost, vercelSandboxHost } from "./cloud_runner.ts";
import { dispatchPrepare, handlePrepareBridge, handlePrepareDoor, type PrepareRequestRow } from "./cloud_prepare.ts";

export interface RunnerEnv { get(k: string): string | undefined }
// The numbers the runner reads (docs/launch/CLOUD-RUNNER.md, "Limits"). Only infrastructure sizing has a default (how many
// sandboxes at once, per family, per tick: the runner's own capacity). The owner's NO LIMITS rule (2026-10-27, D-MS-2):
// Trainee has no per-person or per-site number of its own; those are optional (OPTIONAL_LIMITS), null when unset, and
// the only brake by default is an outside system refusing (a portal's 429 or bot wall pauses the family).
export const LIMIT_DEFAULTS = {
  CLOUD_MAX_STARTS_PER_TICK: 2, CLOUD_MAX_CONCURRENT: 2, CLOUD_MAX_PER_PORTAL: 1,
  CLOUD_PREPARE_STARTS_PER_TICK: 2, CLOUD_PREPARE_MAX_CONCURRENT: 2,
} as const;
export const OPTIONAL_LIMITS = ["CLOUD_MAX_PER_PERSON_DAY", "CLOUD_MAX_PER_SITE_MINUTE", "CLOUD_PREPARE_PER_PERSON_DAY", "CLOUD_PREPARE_PER_SITE_MINUTE"] as const;
export function runnerLimits(env: RunnerEnv) {
  const num = (k: keyof typeof LIMIT_DEFAULTS) => {
    const n = Number(env.get(k) ?? "");
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : LIMIT_DEFAULTS[k];
  };
  // A number someone set, or null (no number: unset, empty or nonsense is never turned into a default).
  const opt = (k: typeof OPTIONAL_LIMITS[number]): number | null => {
    const n = Number(env.get(k) ?? "");
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  return {
    send: { want: num("CLOUD_MAX_STARTS_PER_TICK"), global: num("CLOUD_MAX_CONCURRENT"), perPortal: num("CLOUD_MAX_PER_PORTAL"),
      perPersonDay: opt("CLOUD_MAX_PER_PERSON_DAY"), perSiteMinute: opt("CLOUD_MAX_PER_SITE_MINUTE") },
    prepare: { want: num("CLOUD_PREPARE_STARTS_PER_TICK"), global: num("CLOUD_PREPARE_MAX_CONCURRENT"), perPersonDay: opt("CLOUD_PREPARE_PER_PERSON_DAY"),
      perSiteMinute: opt("CLOUD_PREPARE_PER_SITE_MINUTE") },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// The Vercel sandbox host as this function's secrets configure it (docs/launch/CLOUD-RUNNER.md). UPMORE_SCRIPT_SUBMIT_LIVE=1
// is the owner's switch for scripted Submits (every Ashby form): it reaches the preparation and the send sandboxes alike,
// so the destination a card was prepared with is the one the send binds.
export function sandboxHostOptions(env: (k: string) => string, f: typeof fetch): Parameters<typeof vercelSandboxHost>[0] {
  return {
    token: env("VERCEL_TOKEN"), teamId: env("VERCEL_TEAM_ID"), projectId: env("VERCEL_PROJECT_ID"),
    snapshotId: env("CLOUD_SANDBOX_SNAPSHOT_ID"), region: env("CLOUD_SANDBOX_REGION") || "iad1",
    vcpus: Number(env("CLOUD_SANDBOX_VCPUS")) >= 1 ? Math.floor(Number(env("CLOUD_SANDBOX_VCPUS"))) : 2,
    scriptSubmitLive: env("UPMORE_SCRIPT_SUBMIT_LIVE") === "1", fetch: f,
  };
}

export function createRunnerHandler(o: {
  env: RunnerEnv; fetch?: typeof fetch; host?: SandboxHost; waitUntil?: (p: Promise<unknown>) => void; now?: () => number;
}): (req: Request) => Promise<Response> {
  const f = o.fetch ?? fetch;
  const env = (k: string) => o.env.get(k) || "";
  return async (req) => {
    const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY"), secret = env("CLOUD_RUNNER_SECRET");
    if (!url || !key || secret.length < 32) return json(503, { error: "not configured" });
    if (req.method !== "POST") return json(405, { error: "POST only" });
    const rest = url.replace(/\/$/, "") + "/rest/v1";
    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const rpc: Rpc = async (name, args) => {
      const r = await f(`${rest}/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text)?.message ?? text; } catch { /* as sent */ }
        throw Error(String(msg).slice(0, 300));
      }
      return text ? JSON.parse(text) : null;
    };
    const limits = runnerLimits(o.env);
    const host = () => o.host ?? vercelSandboxHost(sandboxHostOptions(env, f));
    const hostReady = () => {
      if (o.host) return null;
      for (const k of ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "CLOUD_SANDBOX_SNAPSHOT_ID", "CLOUD_BRIDGE_URL"]) if (!env(k)) return k;
      return null;
    };
    const stop = o.host || env("VERCEL_TOKEN") ? (s: string) => host().stop(s) : undefined;
    const path = new URL(req.url).pathname;
    const tickSecret = () => same(req.headers.get("x-cloud-dispatch-secret") || "", env("CLOUD_DISPATCH_SECRET"));
    const runPrepare = () => dispatchPrepare({ rpc, host: host(), secret, bridgeUrl: env("CLOUD_BRIDGE_URL"), limits: limits.prepare });

    if (path.endsWith("/prepare-dispatch")) {
      if (!env("CLOUD_DISPATCH_SECRET") || !tickSecret()) return json(401, { error: "unauthorized" });
      if (env("CLOUD_PREPARE_ENABLED") !== "on") return json(200, { skipped: "CLOUD_PREPARE_ENABLED is not on" });
      const missing = hostReady();
      if (missing) return json(503, { error: `not configured: ${missing}` });
      return json(200, await runPrepare());
    }
    if (path.endsWith("/prepare")) {
      const token = env("CAREER_PREPARE_AHEAD_TOKEN");
      if (!token || !same(req.headers.get("authorization") || "", `Bearer ${token}`)) return json(401, { error: "unauthorized" });
      if (env("CLOUD_PREPARE_ENABLED") !== "on") return json(503, { error: "preparation is not on" });
      const missing = hostReady();
      if (missing) return json(503, { error: `not configured: ${missing}` });
      let body: unknown = null;
      try { body = await req.json(); } catch { return json(400, { error: "bad request" }); }
      const out = await handlePrepareDoor(body, { rpc, perPersonDay: limits.prepare.perPersonDay,
        kick: () => {
          const p = runPrepare().catch((e) => console.error(`prepare dispatch: ${(e as Error)?.message ?? e}`));
          if (o.waitUntil) o.waitUntil(p);
        } });
      return json(out.status, out.body);
    }
    if (path.endsWith("/dispatch")) {
      if (!env("CLOUD_DISPATCH_SECRET") || !tickSecret()) return json(401, { error: "unauthorized" });
      if (env("CLOUD_RUNNER_ENABLED") !== "on") return json(200, { skipped: "CLOUD_RUNNER_ENABLED is not on" });
      const missing = hostReady();
      if (missing) return json(503, { error: `not configured: ${missing}` });
      return json(200, await dispatch({ rpc, host: host(), secret, bridgeUrl: env("CLOUD_BRIDGE_URL"), limits: limits.send }));
    }
    const p = /\/prep\/([a-z]+)$/.exec(path);
    if (p) {
      let body: unknown = null;
      try { body = await req.json(); } catch { return json(400, { error: "invalid request" }); }
      const readRequest = async (id: string) => {
        const r = await f(`${rest}/career_apply_prepare_requests?id=eq.${encodeURIComponent(id)}&select=id,user_id,job_ids,state,lease_token,claimed_at`, { headers });
        if (!r.ok) throw Error(`read ${r.status}`);
        return ((await r.json()) as PrepareRequestRow[])[0] ?? null;
      };
      const out = await handlePrepareBridge(p[1], body, { rpc, readRequest, secret, stop, now: o.now });
      return json(out.status, out.body);
    }
    const m = /\/job\/([a-z]+)$/.exec(path);
    if (m) {
      let body: unknown = null;
      try { body = await req.json(); } catch { return json(400, { error: "invalid request" }); }
      const readJob = async (id: string) => {
        const r = await f(`${rest}/career_apply_jobs?id=eq.${encodeURIComponent(id)}&select=id,lease_token,user_id,company,url,payload,payload_hash,approval_hash,job_id,state,source`, { headers });
        if (!r.ok) throw Error(`read ${r.status}`);
        return ((await r.json()) as ClaimedJob[])[0] ?? null;
      };
      const out = await handleBridge(m[1], body, { rpc, readJob, secret, stop });
      return json(out.status, out.body);
    }
    return json(404, { error: "not found" });
  };
}
