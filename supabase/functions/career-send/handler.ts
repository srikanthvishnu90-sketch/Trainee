// career-send (mass networking, lane M1): one sender instance of the sending rail (_shared/career_send_rail.ts). pg_cron
// starts several every minute (scripts/launch/schedule-career-proactive.sql, job trainee-career-send); each claims whole
// sender accounts with skip-locked leases, sends until nothing is due or its time is up, then reads the threads of emails
// already sent for replies, "stop"s and bounces. Instances never collide: the database hands each account to one at a
// time. Off until the owner turns it on (CAREER_SEND_RAIL=on): until then it answers {"off": true} and sends nothing.
// Authorized by the scheduler's secret (CAREER_PROACTIVE_SECRET in x-trainee-proactive-secret, as career-proactive).
import { equalSecret } from "../_shared/message_service.ts";
import { runReplyCheck, runSendWorker, sendRailOn, type WorkerDeps } from "../_shared/career_send_rail.ts";

export interface SendFnDeps {
  env: { get(k: string): string | undefined };
  rail: () => WorkerDeps;
  now: () => number;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleSend(req: Request, d: SendFnDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("CAREER_PROACTIVE_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: CAREER_PROACTIVE_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-proactive-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  if (!sendRailOn(d.env)) return json({ off: true, why: "CAREER_SEND_RAIL is not on" });
  const started = d.now();
  const worker = `career-send:${crypto.randomUUID()}`;
  const rail = d.rail();
  // Sizes of one claim, never limits on what is sent: the worker claims again until nothing is due.
  const num = (k: string, dflt: number) => { const v = Number(d.env.get(k)); return Number.isInteger(v) && v > 0 ? v : dflt; };
  const msg = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  const sends = await runSendWorker(rail, { worker, accounts: num("CAREER_SEND_CLAIM_ACCOUNTS", 20), perAccount: num("CAREER_SEND_CLAIM_PER_ACCOUNT", 25), leaseSeconds: 120, deadlineMs: 100_000 }).catch(msg);
  // Mailbox protection after a bounce: the account's last WINDOW sends, at least BOUNCES of them bounced and at least
  // RATE of them; then that account pauses until the person says "resume sending". A reaction to Gmail's signal, not a cap.
  const rate = Number(d.env.get("CAREER_SEND_BOUNCE_RATE"));
  const pause = { window: num("CAREER_SEND_BOUNCE_WINDOW", 50), bounces: num("CAREER_SEND_BOUNCE_COUNT", 5), rate: rate > 0 && rate <= 1 ? rate : 0.1 };
  const replies = await runReplyCheck(rail, { limit: 200, pause }).catch(msg);
  const failed = !("claims" in sends);
  return json({ worker, sends, replies, ms: d.now() - started }, failed ? 500 : 200);
}
