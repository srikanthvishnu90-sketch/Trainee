// ops-monitor: GET/POST /functions/v1/ops-monitor?mode=check|digest|report, authenticated by a HEADER only:
//   Authorization: Bearer <OPS_MONITOR_TOKEN>  or  x-ops-token: <OPS_MONITOR_TOKEN>.
// A token in the URL (?token=) is refused, valid or not: Supabase logs record query strings, so it would leak into the logs.
//   check   (every 5 minutes) evaluates the monitors, writes ops_* founder_alerts rows, messages the owner once per alert.
//   digest  (once a day) sends the funnel of the last full UTC day and spend to the owner chat; at most once a day unless force=1.
//   report  returns the funnel as text for the last `days` (default 7) without sending anything.
// Deploy with --no-verify-jwt (a scheduler carries no JWT); the token is the authentication.
import { buildFunnel, type FunnelSource, renderFunnel } from "../_shared/ops_funnel.ts";
import { buildDigest, dispatch, digestAlreadySent, edge5xxFetcher, evaluate, readSnapshot, sendOwner } from "../_shared/ops_monitor.ts";

export interface OpsDeps { env: { get(k: string): string | undefined }; admin: any; source: FunnelSource; now?: () => number; request?: typeof fetch }
const same = (a: string | null, b: string | undefined) => { if (!b || b.length < 16 || !a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleOps(req: Request, d: OpsDeps): Promise<Response> {
  const url = new URL(req.url), now = (d.now ?? Date.now)();
  if (url.searchParams.has("token")) return json({ error: "unauthorized: send the token in the Authorization: Bearer or x-ops-token header, never in the URL (URLs are logged); rotate any token that was sent in a URL" }, 401);
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? null;
  if (!same(req.headers.get("x-ops-token") || bearer, d.env.get("OPS_MONITOR_TOKEN"))) return json({ error: "unauthorized" }, 401);
  const mode = url.searchParams.get("mode") ?? "check";
  if (mode === "check") {
    const snap = await readSnapshot(d.admin, d.env, now, edge5xxFetcher(d.env, now, d.request));
    const alerts = evaluate(snap);
    const sent = await dispatch(d.admin, d.env, alerts, now, d.request);
    const notMeasured = Object.entries({ ingest: snap.ingest, delivery: snap.delivery, apply_worker: snap.worker, budget_refusals: snap.refusals, spend: snap.spend, http_5xx: snap.http5xx }).filter(([, v]) => v === null).map(([k]) => k);
    return json({ ok: true, evaluated: alerts.length, sent, not_measured: notMeasured });
  }
  if (mode === "digest") {
    const day = new Date(now).toISOString().slice(0, 10);
    if (url.searchParams.get("force") !== "1" && await digestAlreadySent(d.admin, day)) return json({ ok: true, skipped: "already sent today" });
    const text = await buildDigest(d.admin, d.env, d.source, now);
    const telegram = await sendOwner(d.env, text, d.request);
    await d.admin.from("founder_alerts").insert({ kind: "ops_digest", user_id: null, detail: { key: day, telegram, text } });
    return json({ ok: true, telegram, text });
  }
  if (mode === "report") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    const end = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") + 24 * 3600000;
    const f = await buildFunnel(d.source, new Date(end - days * 24 * 3600000).toISOString(), new Date(end).toISOString());
    return new Response(renderFunnel(f, { maxUsers: 20, maxDays: days }), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return json({ error: "unknown mode" }, 400);
}
