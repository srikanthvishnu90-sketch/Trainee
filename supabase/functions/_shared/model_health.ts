// Model health (2026-10-11). Live finding: from 19:01 UTC every model call failed and nothing noticed until a person read
// the replies. This answers, in one request an uptime monitor can make every few minutes:
//   - probe=1: one tiny real call to the configured provider (recorded like any other call), so a dead key shows even
//     with no users;
//   - the verdict over the last 15 minutes of real calls (public.model_health): ok, idle, degraded or down;
//   - 503 when degraded or down (the monitor pages on a non-200), plus a founder_alerts row at most once an hour.
// Access: the HEALTH_CHECK_TOKEN secret, as the x-health-token header or ?token= (most monitors can only set a URL).
import { callModel, modelConfig, adminHealthSink, providerName } from "./model_gateway.ts";
import { ModelUnavailableError } from "./model_calls.ts";

type Env = { get(name: string): string | undefined };
export interface HealthDeps { env: Env; admin: any; request?: typeof fetch; now?: () => number }

export function tokenOk(given: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < 16 || !given || given.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function handleHealth(req: Request, d: HealthDeps): Promise<Response> {
  const url = new URL(req.url);
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!tokenOk(req.headers.get("x-health-token") || url.searchParams.get("token"), d.env.get("HEALTH_CHECK_TOKEN"))) return json({ error: "unauthorized" }, 401);
  const cfg = modelConfig(d.env, "chat");
  let probe: any = null;
  if (url.searchParams.get("probe") === "1") {
    const started = (d.now || Date.now)();
    try {
      const r = await callModel(cfg, { max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] }, { role: "probe", request: d.request, timeoutMs: 20000, health: adminHealthSink(d.admin) });
      const text = (r.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      probe = { ok: true, reply: text.slice(0, 40), latency_ms: (d.now || Date.now)() - started };
    } catch (e) {
      probe = { ok: false, error: e instanceof ModelUnavailableError ? e.summary() : (e instanceof Error ? e.message : String(e)).slice(0, 240) };
    }
  }
  const v = await d.admin.rpc("model_health", { p_minutes: 15 });
  if (v.error) return json({ status: "unknown", provider: providerName(cfg), model: cfg.model, probe, error: "health table unreadable" }, 503);
  const verdict = v.data || {};
  // A failed probe is down on its own: the very next real message would fail the same way.
  const status = probe && !probe.ok ? "down" : verdict.status;
  const body = { status, provider: providerName(cfg), model: cfg.model, probe, window: verdict };
  if (status === "down" || status === "degraded") {
    try {
      const since = new Date((d.now || Date.now)() - 3600000).toISOString();
      const recent = await d.admin.from("founder_alerts").select("id", { count: "exact", head: true }).eq("kind", "model_down").gte("created_at", since);
      if (!recent.error && (recent.count ?? 0) === 0) await d.admin.from("founder_alerts").insert({ kind: "model_down", user_id: null, detail: body });
    } catch (_) { /* the 503 is the page; the alert row is a record */ }
    return json(body, 503);
  }
  return json(body, 200);
}
