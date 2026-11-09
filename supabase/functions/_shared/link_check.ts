// WO-106 (F4; a sample of 60 shown links had 31 verifiably live and 3 confirmed dead): every job link is checked just before
// it is shown. A Greenhouse or Lever posting is asked of its own board's public API by id (a closed posting is a 404 there);
// any other link is fetched and a 404 or 410, or Greenhouse's redirect to "?error=true", is dead. A check that cannot finish
// (timeout, network) is "unknown": never called live, never hidden as dead. Wrong is worse than empty: a dead link is never
// shown.
export type LinkState = "live" | "dead" | "unknown";
export type LinkCheck = (job: { job_id?: string; url?: string }) => Promise<LinkState>;

export function apiUrlFor(jobId: string): string | null {
  const m = /^(greenhouse|lever|smartrecruiters):([A-Za-z0-9._-]+):([A-Za-z0-9-]+)$/.exec(String(jobId ?? ""));
  if (!m) return null;
  const [, family, board, id] = m;
  if (family === "greenhouse") return /^\d+$/.test(id) ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : null;
  // R10 WO-C: SmartRecruiters' public posting API answers 404 for a posting that is gone.
  if (family === "smartrecruiters") return /^\d+$/.test(id) ? `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}` : null;
  return /^[0-9a-f-]{8,}$/i.test(id) ? `https://api.lever.co/v0/postings/${board}/${id.toLowerCase()}` : null;
}
// R10 WO-C: an Ashby posting is live while its board's public list still holds its id (the list answers for every board).
export function ashbyBoardFor(jobId: string): { url: string; id: string } | null {
  const m = /^ashby:([A-Za-z0-9._-]+):([0-9a-f-]{8,})$/i.exec(String(jobId ?? ""));
  return m ? { url: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, id: m[2].toLowerCase() } : null;
}

export function linkChecker(f: typeof fetch, o: { timeoutMs?: number; userAgent?: string } = {}): LinkCheck {
  const timeoutMs = o.timeoutMs ?? 4000, ua = o.userAgent ?? "Trainee job link check";
  const get = async (url: string) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(url, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": ua, accept: "application/json,text/html" } });
      await r.body?.cancel().catch(() => {});
      return r;
    } finally { clearTimeout(timer); }
  };
  const ashbyBoards = new Map<string, Promise<Set<string> | "dead" | "unknown">>();
  const readAshby = async (url: string): Promise<Set<string> | "dead" | "unknown"> => {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await f(url, { method: "GET", signal: ctl.signal, headers: { "user-agent": ua, accept: "application/json" } });
        if (r.status === 404) { await r.body?.cancel().catch(() => {}); return "dead"; }
        if (!r.ok) { await r.body?.cancel().catch(() => {}); return "unknown"; }
        const body: any = await r.json().catch(() => null);
        return Array.isArray(body?.jobs) ? new Set(body.jobs.map((j: any) => String(j?.id ?? "").toLowerCase())) : "unknown";
      } finally { clearTimeout(timer); }
    } catch { return "unknown"; }
  };
  return async (job) => {
    const ashby = ashbyBoardFor(String(job.job_id ?? ""));
    if (ashby) {
      // One read of each Ashby board per checker (one checker per turn), its ids kept as a set: the board is not fetched or
      // parsed again for each of its postings.
      const board = await (ashbyBoards.get(ashby.url) ?? (() => { const p = readAshby(ashby.url); ashbyBoards.set(ashby.url, p); return p; })());
      return board === "dead" || board === "unknown" ? board : board.has(ashby.id) ? "live" : "dead";
    }
    const api = apiUrlFor(String(job.job_id ?? ""));
    const url = api ?? String(job.url ?? "");
    if (!/^https?:\/\//i.test(url)) return "dead";
    try {
      const r = await get(url);
      if (r.status === 404 || r.status === 410) return "dead";
      if (/[?&]error=true\b/.test(r.url || "")) return "dead";
      if (r.ok) return "live";
      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

// The shown list after the check: dead ones out (counted), unknown ones kept and marked, so the reply can say so.
export async function liveOnly<T extends { job_id?: string; url?: string }>(hits: T[], check: LinkCheck | null | undefined, want: number):
  Promise<{ shown: (T & { link: LinkState | "unchecked" })[]; dead: number; checked: number }> {
  if (!check) return { shown: hits.slice(0, want).map((h) => ({ ...h, link: "unchecked" as const })), dead: 0, checked: 0 };
  const shown: (T & { link: LinkState })[] = [];
  let dead = 0, checked = 0;
  // In small batches down the ranked list until enough are shown or the list ends; at most 3 * want checks per search.
  for (let i = 0; i < hits.length && shown.length < want && checked < want * 3; i += 4) {
    const batch = hits.slice(i, i + 4);
    const states = await Promise.all(batch.map((h) => check(h)));
    checked += batch.length;
    batch.forEach((h, k) => { if (states[k] === "dead") dead++; else if (shown.length < want) shown.push({ ...h, link: states[k] }); });
  }
  return { shown, dead, checked };
}
