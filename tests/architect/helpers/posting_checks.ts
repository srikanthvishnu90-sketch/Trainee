// architect amendment E.21 (2026-11-10): the one rule every "nothing left the machine" test applies to a search's open check.
// A search re-checks the postings it shows, each on its own posting page by id (Greenhouse, Lever and SmartRecruiters by their
// public APIs, Ashby by its posting page), and never reads a board listing. So a test's network double:
//   - passes a posting-page GET to take(): it is recorded on the turn that made it and refused like any other request
//     (the posting is then shown as "not re-checked");
//   - still counts every other off-machine request, a board listing included, as a fault.
// Each turn runs inside turn(): its posting-page reads must be at most N for the N postings it shows (numbered lines), plus
// the closed ones it says it left out (a closed posting's place goes to the next one, E.21 ruling 1), and never more than 10.
// A posting-page read outside any turn is a fault.
import { AsyncLocalStorage } from "node:async_hooks";

// Architect amendment (D-062): a Workday posting's own page by id is its CXS job endpoint (/wday/cxs/<tenant>/<site>/job/<path>,
// workday_posting.ts); a board listing (/wday/cxs/<tenant>/<site>/jobs) is still not a posting page.
export const POSTING_PAGE =
  /^https:\/\/(?:boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs\/\d+|api\.lever\.co\/v0\/postings\/[^/]+\/[0-9a-f-]{8,}|api\.smartrecruiters\.com\/v1\/companies\/[^/]+\/postings\/\d+|jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{8,}|[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com\/wday\/cxs\/[a-z0-9-]+\/[^/]+\/job\/[^?#]+)$/i;
export const SEARCH_READS_MAX = 10;
export const shownIn = (reply: string) => reply.split("\n").filter((l) => /^\s*\d+\. /.test(l)).length;
export const closedSaidIn = (reply: string) => Number(/(\d+) (?:matching )?roles? (?:was|were) (?:left out: closed when checked|found, but)/.exec(reply)?.[1] ?? 0);

export function postingChecks() {
  const als = new AsyncLocalStorage<string[]>();
  const faults: string[] = [];
  let total = 0;
  return {
    faults,
    get total() { return total; },
    // In the fetch double, before the request is refused or counted: true when it is a posting-page GET (recorded here).
    take(method: string, url: string): boolean {
      const u = new URL(url);
      if (method.toUpperCase() !== "GET" || !POSTING_PAGE.test(`${u.origin}${u.pathname}`)) return false;
      total++;
      const reads = als.getStore();
      if (reads) reads.push(u.href); else faults.push(`posting page read outside a turn: ${u.href}`);
      return true;
    },
    // One turn: run it, then hold its posting-page reads to the postings its reply shows (reply() is read after run()).
    async turn<T>(label: string, run: () => Promise<T>, reply: (r: T) => string): Promise<T> {
      const reads: string[] = [];
      const r = await als.run(reads, run);
      if (reads.length) {
        const text = reply(r), cap = Math.min(shownIn(text) + closedSaidIn(text), SEARCH_READS_MAX);
        if (reads.length > cap) faults.push(`${label.slice(0, 80)}: ${reads.length} posting pages read for ${shownIn(text)} shown (cap ${cap})`);
      }
      return r;
    },
  };
}
