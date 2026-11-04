// Audit B2 (docs/architect/LAUNCH-READINESS-2026-10-26.md): a person with only a phone gets applications prepared only
// by the server's preparation host (workers/career-browser/prepare-ahead.ts serve, on the owner's VM). This says, in
// plain words the chat can show and the launch smoke can check, whether that host is configured and answering, instead
// of the chat promising preparation that nothing does.
//   not_configured  CAREER_PREPARE_AHEAD_URL or CAREER_PREPARE_AHEAD_TOKEN is not set: nothing prepares for a phone-only
//                   person; their queued postings wait (and are prepared only by the extension on a computer)
//   unreachable     configured, but the host did not answer its status in time (down, wrong URL, firewall)
//   refused         the host answered 401/403: the token the chat holds is not the host's
//   up              the host answered its status: it prepares what the chat queues
// It reads only GET <origin of CAREER_PREPARE_AHEAD_URL>/status with the token; it never prepares, sends or logs the token.
export type PrepareHostState = "not_configured" | "unreachable" | "refused" | "up";
export interface PrepareHostStatus {
  state: PrepareHostState;
  // One sentence for the person (no internal names), and one line for the owner (names the setting to fix).
  words: string;
  owner: string;
  detail?: { in_flight?: number; runs?: number; last_run_at?: string | null; last_error?: string | null };
}

export function statusUrl(doorUrl: string): string | null {
  try {
    const u = new URL(doorUrl);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return null;
    return `${u.origin}/status`;
  } catch {
    return null;
  }
}

export async function prepareHostStatus(o: {
  env: { get(k: string): string | undefined };
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<PrepareHostStatus> {
  const url = (o.env.get("CAREER_PREPARE_AHEAD_URL") ?? "").trim(), token = (o.env.get("CAREER_PREPARE_AHEAD_TOKEN") ?? "").trim();
  if (!url || !token) {
    return {
      state: "not_configured",
      words: "Nothing prepares applications for you yet unless the Upmore extension is running on a computer; your queued postings wait until it is.",
      owner: "phone-only preparation is NOT_WIRED: set CAREER_PREPARE_AHEAD_URL and CAREER_PREPARE_AHEAD_TOKEN on agent-chat after the preparation host is up (docs/launch/CLOUD-RUNNER.md, Preparation host)",
    };
  }
  const where = statusUrl(url);
  if (!where) {
    return {
      state: "unreachable",
      words: "Preparing applications on our side is not working right now; your queued postings wait until it is back.",
      owner: "CAREER_PREPARE_AHEAD_URL is not an https URL (the value is not shown)",
    };
  }
  try {
    const r = await (o.fetch ?? fetch)(where, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 4000) });
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      return {
        state: "refused",
        words: "Preparing applications on our side is not working right now; your queued postings wait until it is back.",
        owner: "the preparation host refused the chat's token: CAREER_PREPARE_AHEAD_TOKEN on agent-chat is not the host's",
      };
    }
    // deno-lint-ignore no-explicit-any
    const body: any = r.ok ? await r.json().catch(() => null) : (await r.body?.cancel().catch(() => {}), null);
    if (!r.ok || body?.ok !== true || body?.service !== "prepare-ahead") {
      return {
        state: "unreachable",
        words: "Preparing applications on our side is not working right now; your queued postings wait until it is back.",
        owner: `the preparation host's status answered ${r.status}, not the prepare-ahead status`,
      };
    }
    return {
      state: "up",
      words: "I prepare each queued posting on our side, from the facts you confirmed, and show you the exact application before anything is sent.",
      owner: `preparation host up: ${Number(body.in_flight) || 0} in flight, ${Number(body.runs) || 0} runs since ${String(body.started_at ?? "?")}` +
        (body.last_error ? `; last error: ${String(body.last_error).slice(0, 120)}` : ""),
      detail: { in_flight: Number(body.in_flight) || 0, runs: Number(body.runs) || 0, last_run_at: body.last_run_at ?? null, last_error: body.last_error ?? null },
    };
  } catch {
    return {
      state: "unreachable",
      words: "Preparing applications on our side is not working right now; your queued postings wait until it is back.",
      owner: "the preparation host did not answer its status in time (down, wrong CAREER_PREPARE_AHEAD_URL, or a firewall)",
    };
  }
}
