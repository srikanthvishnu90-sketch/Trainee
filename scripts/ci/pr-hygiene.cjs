#!/usr/bin/env node
"use strict";
// PR HYGIENE (docs/architect/PROCESS.md). Labels and comments only: it never closes, merges, edits, pushes or rebases a
// pull request. Every write goes through `write()` below, which allows exactly three calls: add labels to an issue/PR,
// remove one label from it, and post a comment on it. tests/career-ci-process.test.cjs pins that.
//
//   node scripts/ci/pr-hygiene.cjs open [--dry-run]            label every open PR (stale, conflicting, stacked,
//                                                               based-on-red-trunk, oversize); comment once per new label
//   node scripts/ci/pr-hygiene.cjs s2 <report-file> [--dry-run] read a deploy-standard.ts S2 report and label each merged PR
//                                                               it lists as lacking an approval (needs-s2-approval)
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY. The clock is read once, at the start of a run, and passed down as `now`;
// classify() itself never reads it (the rule PROCESS.md sets for tests).

const STALE_DAYS = 7;
const SIZE_CAP_LINES = 800;
const SIZE_CAP_FILES = 25;
const TRUNK = "trunk";
const RELEASE = "release/production";
// Files a PR regenerates rather than writes; they do not count toward the size cap.
const GENERATED = [
  /^supabase\/functions\/_shared\/router_core[^/]*\.js$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)deno\.lock$/,
  /^scripts\/[^/]*-durations\.json$/,
  /^evals\/.*\/results\//,
  /^docs\/.*\.json$/,
];
const MARKER = "<!-- pr-hygiene -->";
const LABELS = {
  stale: { name: "stale", why: `no new commit for more than ${STALE_DAYS} days: rebase it on a green trunk or close it` },
  conflicting: { name: "conflicting", why: "it conflicts with trunk: rebase it on a green trunk or close it" },
  stacked: { name: "stacked", why: "its base is not trunk: stacked PRs and merge trains are not used; retarget it to trunk" },
  redBase: { name: "based-on-red-trunk", why: "it branches from a trunk commit whose CI failed: rebase it on the latest green trunk" },
  oversize: { name: "oversize", why: `more than ${SIZE_CAP_LINES} changed lines or ${SIZE_CAP_FILES} files (generated files excluded): split it, or the reviewer adds size-exception with the reason` },
  needsS2: { name: "needs-s2-approval", why: "merged without an independent approval at its merged head (deploy standard S2): the reviewer writes the approval now, not at release" },
};
const MANAGED_OPEN = ["stale", "conflicting", "stacked", "redBase", "oversize"].map((k) => LABELS[k].name);
const SIZE_EXCEPTION = "size-exception";

const isGenerated = (f) => GENERATED.some((re) => re.test(f));

// Pure: which managed labels a PR should carry. `pr` is the facts read from the API; nothing here reads the clock.
function classify(pr, now) {
  const out = [];
  const day = 86_400_000;
  if (Number.isFinite(pr.headCommittedAt) && now - pr.headCommittedAt > STALE_DAYS * day) out.push(LABELS.stale.name);
  if (pr.mergeableState === "dirty") out.push(LABELS.conflicting.name);
  if (pr.base !== TRUNK && pr.base !== RELEASE) out.push(LABELS.stacked.name);
  if (pr.base === TRUNK && pr.baseRed === true) out.push(LABELS.redBase.name);
  if (!pr.labels.includes(SIZE_EXCEPTION) && pr.files) {
    const counted = pr.files.filter((f) => !isGenerated(f.filename));
    const lines = counted.reduce((a, f) => a + f.additions + f.deletions, 0);
    if (lines > SIZE_CAP_LINES || counted.length > SIZE_CAP_FILES) out.push(LABELS.oversize.name);
  }
  return out;
}

// What to change on a PR: labels to add and remove among the managed ones. An unknown fact (mergeable state not yet
// computed, files unreadable) neither adds nor removes the label it decides.
function plan(pr, want, managed) {
  const have = pr.labels.filter((l) => managed.includes(l));
  let add = want.filter((l) => !have.includes(l));
  let remove = have.filter((l) => !want.includes(l));
  if (pr.mergeableState === null || pr.mergeableState === "unknown") remove = remove.filter((l) => l !== LABELS.conflicting.name);
  if (pr.files === null) { add = add.filter((l) => l !== LABELS.oversize.name); remove = remove.filter((l) => l !== LABELS.oversize.name); }
  if (pr.baseRed === null) remove = remove.filter((l) => l !== LABELS.redBase.name);
  if (!Number.isFinite(pr.headCommittedAt)) remove = remove.filter((l) => l !== LABELS.stale.name);
  return { add, remove };
}

function commentFor(added) {
  const why = Object.values(LABELS).filter((l) => added.includes(l.name)).map((l) => `- \`${l.name}\`: ${l.why}`);
  return `${MARKER}\nPR hygiene (docs/architect/PROCESS.md) labelled this PR. Nothing was closed or changed.\n\n${why.join("\n")}\n`;
}

// S2 report lines (scripts/launch/deploy-standard.ts report(): four spaces, then "ok   #N" or "BAD  #N").
function parseS2(text) {
  const bad = new Set(), ok = new Set();
  for (const line of String(text).split("\n")) {
    let m = /^\s*BAD\s+#(\d+)\b/.exec(line);
    if (m) { bad.add(Number(m[1])); continue; }
    m = /^\s*ok\s+#(\d+)\b/.exec(line);
    if (m) ok.add(Number(m[1]));
  }
  return { bad: [...bad], ok: [...ok].filter((n) => !bad.has(n)) };
}

// ------------------------------------------------------------------------------------------------ GitHub
function github({ repo, token, dryRun, log = console.log }) {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  async function get(path) {
    const res = await fetch(base + path, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  }
  // The only writes this script can make.
  const ALLOWED = [
    ["POST", /^\/issues\/\d+\/labels$/],
    ["DELETE", /^\/issues\/\d+\/labels\/[^/]+$/],
    ["POST", /^\/issues\/\d+\/comments$/],
  ];
  async function write(method, path, body) {
    if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) throw new Error(`pr-hygiene refuses ${method} ${path}: it only labels and comments`);
    if (dryRun) { log(`DRY-RUN ${method} ${path}${body ? ` ${JSON.stringify(body).slice(0, 160)}` : ""}`); return; }
    const res = await fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  }
  return {
    get,
    write,
    async openPulls() {
      const out = [];
      for (let page = 1; page < 20; page++) {
        const j = (await get(`/pulls?state=open&per_page=100&page=${page}`)) ?? [];
        out.push(...j);
        if (j.length < 100) break;
      }
      return out;
    },
    async files(n) {
      const out = [];
      for (let page = 1; page < 40; page++) {
        const j = await get(`/pulls/${n}/files?per_page=100&page=${page}`).catch(() => null);
        if (!Array.isArray(j)) return null;
        out.push(...j.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })));
        if (j.length < 100) break;
      }
      return out;
    },
    async red(sha, cache) {
      if (cache.has(sha)) return cache.get(sha);
      let red = null;
      const j = await get(`/commits/${sha}/check-runs?per_page=100`).catch(() => null);
      if (j && Array.isArray(j.check_runs)) red = j.check_runs.some((r) => r.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out"));
      cache.set(sha, red);
      return red;
    },
    async label(n, labels, have, managed) {
      const p = plan({ ...have }, labels, managed);
      if (p.add.length) {
        await write("POST", `/issues/${n}/labels`, { labels: p.add });
        await write("POST", `/issues/${n}/comments`, { body: commentFor(p.add) });
      }
      for (const l of p.remove) await write("DELETE", `/issues/${n}/labels/${encodeURIComponent(l)}`);
      return p;
    },
  };
}

async function runOpen(gh, now, log) {
  const pulls = await gh.openPulls();
  const redCache = new Map();
  const rows = [];
  for (const p of pulls) {
    const n = p.number;
    const full = (await gh.get(`/pulls/${n}`).catch(() => null)) ?? p;
    const commit = await gh.get(`/commits/${p.head.sha}`).catch(() => null);
    const committed = commit?.commit?.committer?.date ? Date.parse(commit.commit.committer.date) : NaN;
    let baseRed = false;
    if (p.base.ref === TRUNK) {
      const cmp = await gh.get(`/compare/${TRUNK}...${p.head.sha}`).catch(() => null);
      const mb = cmp?.merge_base_commit?.sha;
      baseRed = mb ? await gh.red(mb, redCache) : null;
    }
    const pr = {
      number: n,
      base: p.base.ref,
      labels: (p.labels ?? []).map((l) => l.name),
      mergeableState: full.mergeable_state ?? null,
      headCommittedAt: committed,
      baseRed,
      files: await gh.files(n),
    };
    const want = classify(pr, now);
    const done = await gh.label(n, want, pr, MANAGED_OPEN);
    rows.push({ n, title: p.title, want, ...done, ageDays: Number.isFinite(committed) ? Math.floor((now - committed) / 86_400_000) : null });
  }
  log(`OPEN PRS ${pulls.length}`);
  for (const k of MANAGED_OPEN) log(`LABEL ${k} ${rows.filter((r) => r.want.includes(k)).length}`);
  for (const r of rows) if (r.want.length || r.remove.length) log(`#${r.n} [${r.want.join(", ") || "clean"}]${r.add.length ? ` +${r.add.join(",")}` : ""}${r.remove.length ? ` -${r.remove.join(",")}` : ""} (last commit ${r.ageDays ?? "?"} d) ${String(r.title).slice(0, 70)}`);
  return rows;
}

async function runS2(gh, reportText, log) {
  const { bad, ok } = parseS2(reportText);
  const managed = [LABELS.needsS2.name];
  for (const n of bad) {
    const p = await gh.get(`/issues/${n}`).catch(() => null);
    if (!p) continue;
    await gh.label(n, managed, { labels: (p.labels ?? []).map((l) => l.name), mergeableState: "clean", files: [], baseRed: false, headCommittedAt: 0 }, managed);
  }
  for (const n of ok) {
    const p = await gh.get(`/issues/${n}`).catch(() => null);
    if (!p || !(p.labels ?? []).some((l) => l.name === LABELS.needsS2.name)) continue;
    await gh.label(n, [], { labels: [LABELS.needsS2.name], mergeableState: "clean", files: [], baseRed: false, headCommittedAt: 0 }, managed);
  }
  log(`S2 merged PRs lacking an approval at their merged head: ${bad.length ? bad.map((n) => `#${n}`).join(", ") : "none"}`);
  return { bad, ok };
}

module.exports = { classify, plan, parseS2, commentFor, github, isGenerated, LABELS, MANAGED_OPEN, STALE_DAYS, SIZE_CAP_LINES, SIZE_CAP_FILES, MARKER };

if (require.main === module) {
  (async () => {
    const [cmd, arg] = process.argv.slice(2);
    const dryRun = process.argv.includes("--dry-run");
    const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
    if (!repo || !token || !["open", "s2"].includes(cmd) || (cmd === "s2" && !arg)) {
      console.error("usage: GITHUB_REPOSITORY=... GITHUB_TOKEN=... pr-hygiene.cjs open|s2 <report-file> [--dry-run]");
      process.exit(2);
    }
    const gh = github({ repo, token, dryRun });
    if (cmd === "open") await runOpen(gh, Date.now(), console.log);
    else await runS2(gh, require("node:fs").readFileSync(arg, "utf8"), console.log);
  })().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
}
