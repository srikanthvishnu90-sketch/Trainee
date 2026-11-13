// WO-106 (F4; a sample of 60 shown links had 31 verifiably live and 3 confirmed dead): every job link is checked just before
// it is shown. A Greenhouse or Lever posting is asked of its own board's public API by id (a closed posting is a 404 there);
// any other link is fetched and a 404 or 410, or Greenhouse's redirect to "?error=true", is dead. A check that cannot finish
// (timeout, network) is "unknown": never called live, never hidden as dead. Wrong is worse than empty: a dead link is never
// shown.
// Review of #775 (2026-11-13): every request goes through posting_fetch.ts: redirects are walked by hand (at most 3, each hop
// held to the same rule as the first address: https, a named public host, never a site Trainee does not open, and a job board's
// own host when the first address was one); a refused address or hop is "unknown", never live. A board name or posting id that
// is not a plain slug builds no address. A Workday posting is live only when its own data says canApply true.
import { isWorkdayHost, parseWorkdayCxs, workdayState, workdayUrl } from "./workday_posting.ts";
import { boardHost, BOARD_SLUG, guardedText, parseJson, POSTING_UUID, type Resolve, sameBoard } from "./posting_fetch.ts";
import { ashbyAppData, boardOf, boardState, type PostingState } from "./posting_requirements.ts";
export type LinkState = "live" | "dead" | "unknown";
// Architect ruling E.21 (release item 8): every search re-checks the postings it shows, and only those (searchCheck below):
// at most the count asked, never more than SEARCH_CHECK_MAX, each on its own posting page by id. No board listing is read.
export const SEARCH_CHECK_MAX = 10;
// `debug` (linkChecker's checkers carry it): dns_checked false when an employer page was requested with no name lookup because
// this runtime has no resolver (posting_fetch.ts). For logs and tests; never part of what a model is shown.
export type LinkCheck = ((job: { job_id?: string; url?: string }) => Promise<LinkState>) & { debug?: { dns_checked: boolean } };

// `eu`: the posting is on the board's EU site. Lever's EU postings are in its EU API (api.eu.lever.co).
export function apiUrlFor(jobId: string, eu = false): string | null {
  const m = /^(greenhouse|lever|smartrecruiters):([A-Za-z0-9._-]+):([A-Za-z0-9-]+)$/.exec(String(jobId ?? ""));
  if (!m || !BOARD_SLUG.test(m[2])) return null;
  const [, family, board, id] = m;
  if (family === "greenhouse") return /^\d+$/.test(id) ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : null;
  // R10 WO-C: SmartRecruiters' public posting API answers 404 for a posting that is gone.
  if (family === "smartrecruiters") return /^\d+$/.test(id) ? `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}` : null;
  return POSTING_UUID.test(id) ? `https://${eu ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${board}/${id.toLowerCase()}` : null;
}
// R10 WO-C: an Ashby posting is live while its board's public list still holds its id (the list answers for every board).
export function ashbyBoardFor(jobId: string): { url: string; id: string } | null {
  const m = /^ashby:([A-Za-z0-9._-]+):([0-9a-f-]{8,})$/i.exec(String(jobId ?? ""));
  return m && BOARD_SLUG.test(m[1]) && POSTING_UUID.test(m[2]) ? { url: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, id: m[2].toLowerCase() } : null;
}

// An Ashby posting's own page by id (jobs.ashbyhq.com/<board>/<id>), for a check that never reads the board's listing.
export function ashbyPageFor(jobId: string): string | null {
  const m = /^ashby:([A-Za-z0-9._-]+):([0-9a-f-]{8,})$/i.exec(String(jobId ?? ""));
  return m && BOARD_SLUG.test(m[1]) && POSTING_UUID.test(m[2]) ? `https://jobs.ashbyhq.com/${m[1]}/${m[2].toLowerCase()}` : null;
}

// `ashby: "posting"` (E.21, the search path): an Ashby posting is checked on its own page by id, never by reading the board's
// list; a 404 or 410, or a redirect off the posting's own page, is dead. The default ("board") keeps the board-list read.
export function linkChecker(f: typeof fetch, o: { timeoutMs?: number; userAgent?: string; ashby?: "board" | "posting"; resolve?: Resolve; now?: () => number } = {}): LinkCheck {
  const timeoutMs = o.timeoutMs ?? 4000, ua = o.userAgent ?? "Trainee job link check";
  // One guarded request (posting_fetch.ts) under one time limit that holds whatever the fetch does: a board address stays on the
  // boards' hosts through every hop; any other host is looked up first (o.resolve, default the system resolver) and refused
  // when its name leads to a private address. The body is read to 2 MB (or `max`), or dropped unread (body false).
  const ask = (url: string, accept: string, x: { body?: boolean; max?: number } = {}) =>
    guardedText(f as any, url, { method: "GET", headers: { "user-agent": ua, accept } }, { ...(boardHost(url) ? { allow: sameBoard(url) } : {}), resolve: o.resolve, timeoutMs, ...x });
  // Round 4: the state is the reader's own (posting_requirements.ts boardState, workday_posting.ts workdayState), so the link
  // check and the reader cannot disagree: open is live, closed is dead, anything else (not this posting's data included) unknown.
  const today = () => new Date((o.now ?? Date.now)()).toISOString().slice(0, 10);
  const linkOf = (s: PostingState | null): LinkState => s === "open" ? "live" : s === "closed" ? "dead" : "unknown";
  const ashbyBoards = new Map<string, Promise<Set<string> | "dead" | "unknown">>();
  const readAshby = async (url: string): Promise<Set<string> | "dead" | "unknown"> => {
    try {
      // A whole board's list (larger than one posting): read to 16 MB.
      const r = await ask(url, "application/json", { max: 16 * 1024 * 1024 });
      if (r.status === 404) return "dead";
      if (!r.ok) return "unknown";
      const body = parseJson(r.text);
      return Array.isArray(body?.jobs) ? new Set(body.jobs.map((j: any) => String(j?.id ?? "").toLowerCase())) : "unknown";
    } catch { return "unknown"; }
  };
  const debug = { dns_checked: true };
  return Object.assign(async (job: { job_id?: string; url?: string }): Promise<LinkState> => {
    let id = String(job.job_id ?? "");
    const link = String(job.url ?? "");
    // Round 2: a job board's page address with no board job_id is asked of the board by the posting id its address names; no
    // board's page (an app shell, a bot wall, a redirect to the employer's site) is ever the check.
    const named = boardOf(link), eu = named?.eu === true;
    if (!apiUrlFor(id) && !ashbyPageFor(id) && named && named.board !== "Workday") id = `${named.board.toLowerCase()}:${named.parts[0]}:${named.parts[1]}`;
    const page = o.ashby === "posting" ? ashbyPageFor(id) : null;
    if (page) {
      try {
        const r = await ask(page, "text/html");
        if (r.status === 404 || r.status === 410) return "dead";
        const pid = page.split("/").at(-1)!;
        if (r.ok && !r.url.toLowerCase().includes(pid)) return "dead";
        // Live needs the page's own data to hold this posting, listed, its deadline not passed; a 200 without it is not confirmed.
        return r.ok ? linkOf(boardState("Ashby", ashbyAppData(r.text)?.posting, pid, today())) : "unknown";
      } catch {
        return "unknown";
      }
    }
    // D-062: a Workday posting is asked of its own CXS endpoint by its path (workday_posting.ts). Its public page is the same app
    // shell (HTTP 200) for a live and a removed posting, so the page itself is never the check. Gone: HTTP 404 or 410, or
    // errorCode S21 / S22, or canApply false; live: the answer holds the posting and says canApply true; anything else (canApply
    // absent included, and a Workday address that names no posting) is unknown.
    const wd = workdayUrl(link);
    if (wd) {
      try {
        const r = await ask(wd.cxs, "application/json"), body = parseJson(r.text);
        if (r.status === 404 || r.status === 410 || body?.errorCode === "S21" || body?.errorCode === "S22") return "dead";
        const p = r.ok ? parseWorkdayCxs(body, wd.page) : null;
        return p ? linkOf(workdayState(p, wd, today()).state) : "unknown";
      } catch { return "unknown"; }
    }
    const ashby = ashbyBoardFor(id);
    if (ashby) {
      // One read of each Ashby board per checker (one checker per turn), its ids kept as a set: the board is not fetched or
      // parsed again for each of its postings.
      const board = await (ashbyBoards.get(ashby.url) ?? (() => { const p = readAshby(ashby.url); ashbyBoards.set(ashby.url, p); return p; })());
      return board === "dead" || board === "unknown" ? board : board.has(ashby.id) ? "live" : "dead";
    }
    // Any other employer page (and, as on trunk, the page of a board whose regional API is not known). An address that is never
    // requested (plain http, an IP, a reserved or private name, a name that leads to a private address, userinfo, a never-open
    // site) throws: unknown.
    const pageCheck = async (): Promise<LinkState> => {
      try {
        const r = await ask(link, "application/json,text/html", { body: false });
        if (!r.dns_checked) debug.dns_checked = false;
        if (r.status === 404 || r.status === 410) return "dead";
        if (/[?&]error=true\b/.test(r.url)) return "dead";
        return r.ok ? "live" : "unknown";
      } catch {
        return "unknown";
      }
    };
    const api = apiUrlFor(id, eu);
    if (api) {
      // The board's posting API by id: live only when its answer IS the posting (its id, its title, and its active flag where
      // the API has one). An error body, another posting, or HTML where JSON belongs is unknown.
      try {
        const r = await ask(api, "application/json");
        const [family, , pid] = id.split(":");
        // A board on Greenhouse's EU site is not in the global API and its regional API is not known here: the global 404 does
        // not end the posting. As on trunk, its own page answers.
        if ((r.status === 404 || r.status === 410) && eu && family === "greenhouse") return await pageCheck();
        if (r.status === 404 || r.status === 410) return "dead";
        if (/[?&]error=true\b/.test(r.url)) return "dead";
        if (!r.ok) return "unknown";
        const j = parseJson(r.text);
        // A 200 whose body is not JSON keeps trunk's answer ("live") for now: tests/architect/wo-106-agent-slice.test.ts:180
        // pins it. tests/architect/pending/posting-link-nonjson-20261113.test.ts wants "unknown" here (a bot wall is not a posting).
        if (j === null && !/^\s*null\s*$/.test(r.text)) return "live";
        return linkOf(boardState(family === "greenhouse" ? "Greenhouse" : family === "lever" ? "Lever" : "SmartRecruiters", j, pid, today(), { titled: false }));
      } catch { return "unknown"; }
    }
    if (!/^https?:\/\//i.test(link)) return "dead";
    // A job board's or Workday's host whose address names no posting: its page answers 200 whatever it holds. Unknown.
    if (boardHost(link) || isWorkdayHost(link)) return "unknown";
    return await pageCheck();
  }, { debug });
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

// E.21: the search's own check. Only postings about to be shown are checked: the first n (n at most SEARCH_CHECK_MAX), one
// page each, in parallel. A closed one is left out (counted) and its place goes to the next posting down the list, which is then
// checked the same way; at most SEARCH_CHECK_MAX pages are read in all. One whose check could not run stays, marked "unknown"
// (said as not re-checked). No board listing is read here.
export async function searchCheck<T extends { job_id?: string; url?: string }>(hits: T[], check: LinkCheck, n: number):
  Promise<{ shown: (T & { link: LinkState })[]; dead: number; checked: number }> {
  const want = Math.max(0, Math.min(SEARCH_CHECK_MAX, Math.floor(n)));
  const shown: (T & { link: LinkState })[] = [];
  let dead = 0, checked = 0;
  while (shown.length < want && checked < hits.length && checked < SEARCH_CHECK_MAX) {
    const take = hits.slice(checked, checked + Math.min(want - shown.length, SEARCH_CHECK_MAX - checked));
    const states = await Promise.all(take.map((h) => check(h).catch(() => "unknown" as const)));
    checked += take.length;
    take.forEach((h, k) => { if (states[k] === "dead") dead++; else shown.push({ ...h, link: states[k] }); });
  }
  return { shown, dead, checked };
}
