// Build the held-out browser benchmark sample (scripts/browser-eval/heldout.csv): 20 open public postings for each of the
// 11 job sites in sample.csv, with none of sample.csv's URLs or companies. Runs from CI only (the build sandboxes cannot
// reach job sites); the CSV is printed in the job log between HELDOUT-CSV-BEGIN / HELDOUT-CSV-END.
//
// Source of boards: packages/career-data/board-directory.json (boards verified live by a real feed fetch). For each
// provider the boards are shuffled with a fixed seed, sample.csv's companies are excluded (by board token, by host, and,
// for Workable's /j/ links, by the account each sample link redirects to), and one posting is taken per board from the
// board's public feed. A posting is kept only if a second, per-posting read says it is open. Reads only: GET everywhere,
// except Workday's job search and job detail, which are the read-only calls its career site makes (the search is a POST
// that creates and submits nothing). No login, no keys, about 3 requests a second per provider.
//   node scripts/browser-eval/build-heldout.cjs [--per 20] [--seed heldout-1] [--out heldout.csv] [--max-boards 150]
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const UA = "Mozilla/5.0 (compatible; TraineeBenchBuilder/1.0; held-out sample for a dry-run browser benchmark)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const a = process.argv.slice(2), i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };

// ------------------------------------------------------------------ deterministic shuffle
function rng(seed) { let h = 2166136261; for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }
function shuffle(xs, r) { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ------------------------------------------------------------------ company keys
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isOut = (set, s) => { const k = norm(s); return k.length > 0 && set.has(k); }; // an empty key never matches
// The company a posting URL belongs to (as sample.csv writes them); null when the URL does not say (Workable /j/).
function companyOf(provider, url) {
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase(), seg = u.pathname.split("/").filter(Boolean);
  switch (provider) {
    case "greenhouse": case "lever": case "ashby": case "smartrecruiters": return seg[0] || null;
    case "workable": if (host !== "apply.workable.com") { const l = host.split("."); return l[l.length - 2] || null; } // a custom careers domain
      return seg[0] && seg[0] !== "j" && norm(seg[0]) ? seg[0] : null;
    case "workday": return host.split(".")[0];
    case "teamtailor": return host.endsWith(".teamtailor.com") ? host.split(".")[0] : host;
    default: return host.split(".")[0]; // bamboohr, breezy, personio, recruitee: <slug>.<provider host>
  }
}
function boardKey(provider, token) { return provider === "workday" ? String(token).split(".")[0] : token; }

// ------------------------------------------------------------------ HTTP
async function req(url, { method = "GET", body, accept = "application/json", redirect = "follow" } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method, body, redirect, signal: AbortSignal.timeout(20000),
        headers: { "user-agent": UA, accept, ...(body ? { "content-type": "application/json" } : {}) } });
      const text = await res.text();
      if (res.status === 429 && attempt === 0) { await sleep(5000); continue; }
      if (res.status !== 200 || process.env.HELDOUT_DEBUG) console.log(`HTTP | ${method} ${res.status} | ${text.length}b | ${url.slice(0, 110)}${res.url !== url ? " -> " + res.url.slice(0, 80) : ""}`);
      return { status: res.status, text, url: res.url };
    } catch (e) { if (attempt) { console.log(`HTTP | ${method} 0 | ${String(e && e.cause && e.cause.code || e && e.message || e).slice(0, 80)} | ${url.slice(0, 110)}`); return { status: 0, text: "", url, error: String(e && e.message || e).slice(0, 100) }; } await sleep(1000); }
  }
}
const json = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
const blocks = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const field = (b, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(b); return m ? m[1].trim() : null; };

// ------------------------------------------------------------------ per provider: list a board's postings, check one is open
// list(token) -> [{ url, id, company, check }] where check() -> true when a per-posting read says the posting is open.
const enc = encodeURIComponent;
const PROVIDERS = {
  greenhouse: async (t) => { const r = await req(`https://boards-api.greenhouse.io/v1/boards/${enc(t)}/jobs`); const d = json(r.text);
    return (d && d.jobs || []).map((j) => ({ id: String(j.id), url: `https://job-boards.greenhouse.io/${t}/jobs/${j.id}`,
      check: async () => (await req(`https://boards-api.greenhouse.io/v1/boards/${enc(t)}/jobs/${j.id}`)).status === 200 })); },
  lever: async (t) => { const r = await req(`https://api.lever.co/v0/postings/${enc(t)}?mode=json`); const d = json(r.text);
    return (Array.isArray(d) ? d : []).map((j) => ({ id: j.id, url: `https://jobs.lever.co/${t}/${j.id}`,
      check: async () => (await req(`https://api.lever.co/v0/postings/${enc(t)}/${j.id}?mode=json`)).status === 200 })); },
  ashby: async (t) => { const r = await req(`https://api.ashbyhq.com/posting-api/job-board/${enc(t)}`); const d = json(r.text);
    return (d && d.jobs || []).filter((j) => j.isListed !== false).map((j) => ({ id: j.id, url: `https://jobs.ashbyhq.com/${t}/${j.id}`,
      check: async () => { const x = await req(`https://jobs.ashbyhq.com/${t}/${j.id}`, { accept: "text/html" }); return x.status === 200 && x.url.includes(j.id); } })); },
  smartrecruiters: async (t) => { const r = await req(`https://api.smartrecruiters.com/v1/companies/${enc(t)}/postings?limit=100`); const d = json(r.text);
    return (d && d.content || []).map((j) => { const c = (j.company && j.company.identifier) || t; return { id: j.id, company: c, url: `https://jobs.smartrecruiters.com/${c}/${j.id}`,
      check: async () => { const x = json((await req(`https://api.smartrecruiters.com/v1/companies/${enc(c)}/postings/${j.id}`)).text); return !!(x && x.id && x.active !== false); } }; }); },
  workable: async (t) => { const r = await req(`https://apply.workable.com/api/v1/widget/accounts/${enc(t)}`); const d = json(r.text);
    return (d && d.jobs || []).filter((j) => j.shortcode).map((j) => ({ id: j.shortcode, url: `https://apply.workable.com/j/${j.shortcode}`,
      check: async () => { if ((await req(`https://apply.workable.com/api/v2/accounts/${enc(t)}/jobs/${j.shortcode}`)).status === 200) return true;
        const x = await req(`https://apply.workable.com/j/${j.shortcode}`, { accept: "text/html" }); return x.status === 200 && x.url.includes(j.shortcode); } })); },
  recruitee: async (t) => { const r = await req(`https://${t}.recruitee.com/api/offers/`); const d = json(r.text);
    return (d && d.offers || []).filter((j) => j.careers_url && (j.status === undefined || j.status === "published")).map((j) => ({ id: String(j.id), url: j.careers_url,
      check: async () => { const x = await req(`https://${t}.recruitee.com/api/offers/${j.slug || j.id}`); return x.status === 200; } })); },
  bamboohr: async (t) => { const r = await req(`https://${t}.bamboohr.com/careers/list`); const d = json(r.text);
    return (d && d.result || []).map((j) => ({ id: String(j.id), url: `https://${t}.bamboohr.com/careers/${j.id}`,
      check: async () => { const x = json((await req(`https://${t}.bamboohr.com/careers/${j.id}/detail`)).text); return !!(x && x.result && x.result.jobOpening); } })); },
  teamtailor: async (t) => { const r = await req(`https://${t}.teamtailor.com/jobs.rss`, { accept: "application/rss+xml, text/xml" });
    return blocks(r.text, "item").map((it) => field(it, "link")).filter((l) => l && /\/jobs\/\d+/.test(l)).map((l) => { const id = /\/jobs\/(\d+)/.exec(l)[1]; return { id, url: l,
      check: async () => { const x = await req(l, { accept: "text/html" }); return x.status === 200 && x.url.includes(`/jobs/${id}`); } }; }); },
  breezy: async (t) => { const r = await req(`https://${t}.breezy.hr/json`); const d = json(r.text);
    return (Array.isArray(d) ? d : []).filter((j) => j.url).map((j) => ({ id: String(j.id), url: j.url,
      check: async () => { const x = await req(j.url, { accept: "text/html" }); return x.status === 200 && new URL(x.url).pathname.startsWith("/p/"); } })); },
  personio: async (t) => { const r = await req(`https://${t}.jobs.personio.de/xml`, { accept: "application/xml" });
    return blocks(r.text, "position").map((p) => field(p, "id")).filter(Boolean).map((id) => ({ id, url: `https://${t}.jobs.personio.de/job/${id}`,
      check: async () => { const x = await req(`https://${t}.jobs.personio.de/job/${id}`, { accept: "text/html" }); return x.status === 200 && x.url.includes(`/job/${id}`); } })); },
  workday: async (t) => { const m = /^([a-z0-9-]+)\.(wd\d+)\/(.+)$/i.exec(t); if (!m) return []; const [, ten, wd, site] = m, host = `${ten}.${wd}.myworkdayjobs.com`;
    const r = await req(`https://${host}/wday/cxs/${ten}/${enc(site)}/jobs`, { method: "POST", body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }) }); const d = json(r.text);
    return (d && d.jobPostings || []).filter((j) => j.externalPath).map((j) => ({ id: j.externalPath, url: `https://${host}/${site}${j.externalPath}`,
      check: async () => { const x = json((await req(`https://${host}/wday/cxs/${ten}/${enc(site)}${j.externalPath}`)).text); return !!(x && x.jobPostingInfo && x.jobPostingInfo.canApply !== false); } })); },
};

async function main() {
  const per = Number(arg("per", 20)), seed = arg("seed", "heldout-1"), maxBoards = Number(arg("max-boards", 150));
  const sampleRows = fs.readFileSync(path.join(ROOT, "scripts/browser-eval/sample.csv"), "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const i = l.indexOf(","); return { provider: l.slice(0, i), url: l.slice(i + 1).trim() }; });
  const providers = [...new Set(sampleRows.map((r) => r.provider))];
  const sampleUrls = new Set(sampleRows.map((r) => r.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase()));
  // Every company in sample.csv, normalized, across providers (a company sampled on one site is excluded on all).
  const excluded = new Set();
  const exclude = (c) => { if (norm(c)) excluded.add(norm(c)); };
  for (const r of sampleRows) { const c = companyOf(r.provider, r.url); if (c) exclude(c);
    if (c && c.includes(".")) { const l = c.split("."); exclude(l[l.length - 2]); } } // a custom careers domain: its name
  for (const r of sampleRows.filter((x) => x.provider === "workable")) { // /j/<code> -> apply.workable.com/<account>/j/<code>
    const x = await req(r.url, { accept: "text/html" }); const c = companyOf("workable", x.url);
    console.log(`SAMPLE-WORKABLE | ${r.url} -> ${x.status} ${x.url}`); if (c) exclude(c); await sleep(300);
  }
  console.log(`EXCLUDED companies from sample.csv: ${excluded.size}`);

  const dir = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/career-data/board-directory.json"), "utf8")).boards;
  const r = rng(seed);
  const picked = {};
  const usedCompanies = new Set();
  await Promise.all(providers.map(async (p) => {
    const boards = shuffle(dir.filter((b) => b.provider === p && b.status === "live" && Number(b.postings_seen) > 0 && b.board_token), rng(`${seed}:${p}`));
    picked[p] = []; let tried = 0;
    for (const b of boards) {
      if (picked[p].length >= per || tried >= maxBoards) break;
      const key = norm(boardKey(p, b.board_token));
      if (!key || isOut(excluded, key) || usedCompanies.has(key) || isOut(excluded, b.company)) continue;
      tried++;
      let jobs = []; try { jobs = await PROVIDERS[p](b.board_token); } catch (e) { console.log(`SKIP | ${p} | ${b.board_token} | list error ${e.message}`); }
      await sleep(300);
      jobs = jobs.filter((j) => !sampleUrls.has(j.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase()) && !isOut(excluded, j.company) && !isOut(excluded, companyOf(p, j.url)));
      if (!jobs.length) { console.log(`SKIP | ${p} | ${b.board_token} | no postings in feed`); continue; }
      // One posting per board, chosen with the seed; a closed one is replaced by the next of the same board (up to 3).
      let ok = null;
      for (const j of shuffle(jobs, r).slice(0, 3)) { let open = false; try { open = await j.check(); } catch { open = false; } await sleep(300);
        if (open) { ok = j; break; } console.log(`CLOSED | ${p} | ${j.url}`); }
      if (!ok) continue;
      usedCompanies.add(key);
      picked[p].push({ provider: p, url: ok.url, company: b.board_token });
      console.log(`PICK | ${p} | ${picked[p].length}/${per} | ${b.board_token} | ${ok.url}`);
    }
    console.log(`DONE | ${p} | ${picked[p].length}/${per} after ${tried} boards`);
  }));

  const rows = providers.flatMap((p) => picked[p]);
  const csv = ["provider,url", ...rows.map((x) => `${x.provider},${x.url}`)].join("\n") + "\n";
  const out = path.resolve(arg("out", path.join(ROOT, "artifacts/browser-eval/heldout.csv"))); fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, csv);
  console.log("HELDOUT-CSV-BEGIN"); process.stdout.write(csv); console.log("HELDOUT-CSV-END");
  const short = providers.filter((p) => picked[p].length < per);
  console.log(`TOTAL ${rows.length} / ${per * providers.length}${short.length ? ` (short: ${short.map((p) => `${p} ${picked[p].length}`).join(", ")})` : ""}`);
  if (short.length) process.exitCode = 4;
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { companyOf, boardKey, norm };
