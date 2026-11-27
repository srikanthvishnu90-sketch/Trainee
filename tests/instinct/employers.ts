// Instinct harness: the employers. Real HTTP servers on 127.0.0.1 that a real Chromium (scripts/apply.ts, the product's
// engine) loads and submits, one page per posting, shaped like the three ATS families Trainee applies through:
//   greenhouse  #application_form, job_application[...] names, "Submit Application"
//   lever       .application-form, name/email/phone/resume, an empty .h-captcha container (every captured Lever form has
//               one; it is not a challenge), "Submit application"
//   ashby       _systemfield_* names inside .ashby-application-form, "Submit Application"
// Every POST is kept per posting (exactly what was submitted, how many times, the resume file's sha256). A posting can be
// made a captcha wall (an interstitial a person must clear: the engine must stop at needs_user and never retry) or closed.
// Nothing here is a real employer; the synthetic postings' public URLs (boards.greenhouse.io/...) are only identifiers.

export type Ats = "greenhouse" | "lever" | "ashby";
export interface Posting {
  key: string; ats: Ats; board: string; id: string; company: string; title: string; location: string; publicUrl: string;
  // "always": a wall on every visit; "later": the page is open while Trainee prepares, and a wall when it comes back to
  // submit (a bot check that appears later, as real portals do).
  captcha?: "always" | "later"; closed?: boolean;
}
export interface Submission { key: string; fields: Record<string, string>; resumeSha: string | null; resumeName: string | null; at: number }

export const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
export const AUTH = "Are you legally authorized to work in the United States?";

const hex = async (b: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function select(name: string, id: string, label: string) {
  return `<div class="field"><label for="${id}">${esc(label)}</label><select name="${name}" id="${id}" required><option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option></select></div>`;
}
function input(name: string, id: string, label: string, type = "text") {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input type="${type}" name="${name}" id="${id}" required></div>`;
}

export function formHtml(p: Posting, action: string, visit = 1): string {
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)} - ${esc(p.company)}</title></head><body>`;
  const hero = `<h1>${esc(p.title)}</h1><p class="company">${esc(p.company)}</p><p class="location">${esc(p.location)}</p>`;
  if (p.closed) return `${head}${hero}<p>This job is no longer accepting applications.</p></body></html>`;
  // A wall the person must clear themselves. The engine reads "verify you are human" as a challenge at open.
  const walled = p.captcha === "always" || (p.captcha === "later" && visit > 1);
  const wall = walled ? `<div id="challenge-banner"><h2>Verify you are human</h2><p>Complete the security check to continue.</p></div>` : "";
  if (p.ats === "greenhouse") {
    return `${head}${hero}${wall}<form id="application_form" method="post" action="${action}" enctype="multipart/form-data">` +
      input("job_application[first_name]", "first_name", "First Name") + input("job_application[last_name]", "last_name", "Last Name") +
      input("job_application[email]", "email", "Email", "email") + input("job_application[phone]", "phone", "Phone", "tel") +
      `<div class="field"><label for="resume">Resume/CV</label><input type="file" name="job_application[resume]" id="resume" required></div>` +
      select("job_application[answers][0][boolean_value]", "q_auth", AUTH) + select("job_application[answers][1][boolean_value]", "q_sponsor", SPONSOR) +
      `<input type="submit" id="submit_app" value="Submit Application"></form></body></html>`;
  }
  if (p.ats === "lever") {
    return `${head}${hero}${wall}<form class="application-form" id="application-form" method="post" action="${action}" enctype="multipart/form-data">` +
      `<div class="field"><label for="resume-upload-input">Resume/CV</label><input type="file" name="resume" id="resume-upload-input" required></div>` +
      input("name", "name", "Full name") + input("email", "email", "Email", "email") + input("phone", "phone", "Phone", "tel") +
      select("cards[auth][field0]", "card_auth", AUTH) + select("cards[sponsor][field0]", "card_sponsor", SPONSOR) +
      `<div class="h-captcha" data-sitekey="test"></div><button type="submit" class="postings-btn template-btn-submit">Submit application</button></form></body></html>`;
  }
  return `${head}${hero}${wall}<form class="ashby-application-form" method="post" action="${action}" enctype="multipart/form-data">` +
    input("_systemfield_name", "_systemfield_name", "Name") + input("_systemfield_email", "_systemfield_email", "Email", "email") +
    input("phone", "phone", "Phone", "tel") +
    `<div class="field"><label for="_systemfield_resume">Resume</label><input type="file" name="_systemfield_resume" id="_systemfield_resume" required></div>` +
    select("work_auth", "work_auth", AUTH) + select("sponsorship", "sponsorship", SPONSOR) +
    `<button type="submit" class="ashby-application-form-submit-button">Submit Application</button></form></body></html>`;
}

export function employers(initial: Posting[]) {
  const postings: Posting[] = [...initial];
  const byKey = new Map(postings.map((p) => [p.key, p]));
  const submissions: Submission[] = [];
  const opened: { key: string; at: number }[] = [];
  let conf = 1000;
  // The path a real board URL has (boards.greenhouse.io/<board>/jobs/<id>, jobs.lever.co/<board>/<id>,
  // jobs.ashbyhq.com/<board>/<id>): the engine names an employer by its board, so the board leads the path.
  const route = (p: Posting) => `/${p.board}/${p.ats === "greenhouse" ? "jobs/" : ""}${p.id}`;
  const fromPath = (path: string) => postings.find((p) => path === route(p) || path === `${route(p)}/submit`) ?? null;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url), p = fromPath(u.pathname);
    if (!p) return new Response("not found", { status: 404 });
    if (req.method === "POST" && u.pathname.endsWith("/submit")) {
      if (p.closed || p.captcha === "always" || (p.captcha === "later" && opened.filter((o) => o.key === p.key).length > 1)) return new Response("forbidden", { status: 403 });
      const data = await req.formData(), fields: Record<string, string> = {};
      let resumeSha: string | null = null, resumeName: string | null = null;
      for (const [k, v] of data.entries()) {
        if (typeof v === "string") fields[k] = v;
        else { resumeName = v.name; resumeSha = await hex(await v.arrayBuffer()); fields[k] = `file:${v.name}`; }
      }
      submissions.push({ key: p.key, fields, resumeSha, resumeName, at: Date.now() });
      const id = `${p.ats.toUpperCase()}-${p.board.toUpperCase()}-${conf++}`;
      return new Response(`<!doctype html><h1>Thank you for applying</h1><p>Your application to ${esc(p.company)} was received. Confirmation number: ${id}.</p>`, { headers: { "content-type": "text/html" } });
    }
    opened.push({ key: p.key, at: Date.now() });
    return new Response(formHtml(p, `${route(p)}/submit`, opened.filter((o) => o.key === p.key).length), { headers: { "content-type": "text/html" } });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return {
    base, postings, submissions, opened,
    // The posting a job names, by its key, its page URL on this server, or its public URL.
    postingFor: (ref: string): Posting | null => {
      const r = String(ref ?? "");
      return byKey.get(r) ?? postings.find((p) => r === `${base}${route(p)}` || r.startsWith(`${base}${route(p)}?`) || r === p.publicUrl) ?? null;
    },
    add: (ps: Posting[]) => { for (const p of ps) { postings.push(p); byKey.set(p.key, p); } },
    pageFor: (key: string) => { const p = byKey.get(key); return p ? `${base}${route(p)}` : null; },
    // Submissions to a posting's page (a re-listing shares its page: same ATS id, same canonical URL).
    postsTo: (ref: string) => { const p = byKey.get(ref) ?? postings.find((x) => ref === `${base}${route(x)}` || ref === x.publicUrl); return p ? submissions.filter((s) => { const q = byKey.get(s.key); return q && route(q) === route(p); }) : []; },
    submitted: (key: string) => submissions.filter((s) => s.key === key),
    close: () => server.shutdown(),
  };
}

// The synthetic market: n remote software-engineering internships across the three families, at employers whose names
// and domains are synthetic (TEST). `domainOf` gives each employer a mail domain for the people provider.
// Distinct, pronounceable employer names (a company is one employer: names that differ only by a number would be read as
// one company by any sane normalizer). A module counter keeps every market's names apart.
const SYL = ["ka", "lo", "mi", "ra", "ve", "zu", "to", "ne", "pi", "so", "da", "fe", "gu", "hi", "jo", "ku", "ly", "mo", "nu", "qi"];
let named = 0;
export function employerName(): string {
  const i = named++;
  const w = SYL[i % 20] + SYL[Math.floor(i / 20) % 20] + SYL[Math.floor(i / 400) % 20];
  return `TEST ${w[0].toUpperCase()}${w.slice(1)} Systems`;
}
export function market(n: number, o: { captchaAt?: number[]; title?: string; location?: string; tag?: string } = {}): Posting[] {
  const out: Posting[] = [];
  const atsOf: Ats[] = ["greenhouse", "lever", "ashby"];
  for (let i = 1; i <= n; i++) {
    const ats = atsOf[(i - 1) % 3];
    const board = `${o.tag ?? "testco"}${String(i).padStart(3, "0")}`;
    const id = ats === "greenhouse" ? String(4000 + i) : crypto.randomUUID(); // Lever and Ashby job ids are UUIDs
    const company = employerName();
    const publicUrl = ats === "greenhouse" ? `https://boards.greenhouse.io/${board}/jobs/${id}` : ats === "lever" ? `https://jobs.lever.co/${board}/${id}` : `https://jobs.ashbyhq.com/${board}/${id}`;
    out.push({ key: `${ats}:${board}:${id}`, ats, board, id, company, title: o.title ?? "Software Engineering Intern", location: o.location ?? "Remote (US)", publicUrl,
      ...((o.captchaAt ?? []).includes(i) ? { captcha: "later" as const } : {}) });
  }
  return out;
}
export const domainOf = (company: string) => `${company.toLowerCase().replace(/^test /, "").replace(/ systems$/, "").replace(/[^a-z0-9]/g, "")}.example`;
