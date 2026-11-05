// Trainee landing page — owner-only waitlist viewer (KEY-GATED endpoint). Served by ./index.ts.
//
// The key is accepted ONLY from the x-admin-key request header, never from the URL (a ?key= lands in browser history,
// proxy and platform logs, and Referer headers): a request carrying ?key= is refused even when the key is right.
// A GET without the header gets a small key form whose script re-requests this URL with the header and shows the lists.
// With the right header it renders one HTML page listing, newest first:
//   - site_waitlist signups: when, name, phone, source page
//   - site_waitlist_survey answers: when, name, phone, the 3 answers
// The key is compared in constant time (SHA-256 digests compared without an early exit). Every response is
// Cache-Control: no-store with Referrer-Policy: no-referrer. If SITE_ADMIN_KEY is not set the function returns 503 — it
// never serves the lists without a key. Reads use the service role; both tables have RLS on with no public policies.
//
// verify_jwt is OFF: the key is the credential, checked on every request.

export interface AdminDeps {
  env: (k: string) => string | undefined;
  fetchFn: typeof fetch;
}

export const ADMIN_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function respond(body: string, status: number, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { ...ADMIN_HEADERS, "Content-Type": contentType } });
}

// Constant time in the key's content: both sides are hashed to 32 bytes first, so neither the length nor the position of
// the first differing character changes the work done.
export async function keyMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function table(
  headers: string[],
  rows: Record<string, unknown>[],
  keys: string[],
): string {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        "<tr>" +
        keys.map((k) => `<td>${esc(r[k])}</td>`).join("") +
        "</tr>",
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// The key form: the key goes in a header on a same-origin fetch, so it never appears in the address bar or a log line.
function keyForm(note: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Trainee — waitlist admin</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:32px auto;max-width:480px;padding:0 20px;color:#141414}input,button{font-size:16px;padding:8px 10px}#err{color:#B00020}</style>
</head><body>
<h1>Trainee waitlist</h1>
<p>${esc(note)}</p>
<form id="f"><input id="k" type="password" autocomplete="current-password" aria-label="Admin key" placeholder="Admin key" required> <button>Open</button></form>
<p id="err" role="alert"></p>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var k = document.getElementById('k').value;
  fetch(location.pathname, { headers: { 'x-admin-key': k }, cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(r.status === 401 ? 'Wrong key.' : 'Could not load the lists.');
    return r.text();
  }).then(function (html) { document.open(); document.write(html); document.close(); })
    .catch(function (x) { document.getElementById('err').textContent = x.message; });
});
</script>
</body></html>`;
}

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const adminKey = deps.env("SITE_ADMIN_KEY");
    if (!adminKey) return respond("admin not configured", 503);

    const url = new URL(req.url);
    if (url.searchParams.has("key")) {
      return respond(keyForm("The key is no longer accepted in the link. Enter it below; it is sent in a header."), 401, "text/html; charset=utf-8");
    }
    const given = req.headers.get("x-admin-key");
    if (given == null) return respond(keyForm("Enter the admin key."), 401, "text/html; charset=utf-8");
    if (!(await keyMatches(given, adminKey))) return respond("unauthorized", 401);

    const supabaseUrl = deps.env("SUPABASE_URL")!;
    const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY")!;
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const [wRes, sRes] = await Promise.all([
      deps.fetchFn(
        `${supabaseUrl}/rest/v1/site_waitlist?select=name,phone,source,created_at&order=created_at.desc&limit=1000`,
        { headers },
      ),
      deps.fetchFn(
        `${supabaseUrl}/rest/v1/site_waitlist_survey?select=name,phone,q_career_issues,q_platform_issues,q_one_thing,created_at&order=created_at.desc&limit=1000`,
        { headers },
      ),
    ]);
    if (!wRes.ok || !sRes.ok) return respond("could not read lists", 500);
    const waitlist = await wRes.json();
    const survey = await sRes.json();

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Trainee — waitlist admin</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:32px auto;max-width:1100px;padding:0 20px;color:#141414}
h1{font-size:26px} h2{font-size:20px;margin-top:40px}
.count{color:#4A2F5E;font-weight:700}
table{border-collapse:collapse;width:100%;margin-top:12px;font-size:14px}
th,td{border:1px solid #E6E6EA;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#F5F4F7}
td{max-width:340px;overflow-wrap:anywhere;white-space:pre-wrap}
.note{color:#4F4F57;font-size:13px}
</style></head><body>
<h1>Trainee waitlist</h1>
<p><span class="count">${waitlist.length}</span> signups · <span class="count">${survey.length}</span> survey responses · times in UTC, newest first</p>
<h2>Signups — who, when, where from</h2>
${table(["When (UTC)", "Name", "Phone", "Came from"], waitlist, ["created_at", "name", "phone", "source"])}
<h2>Survey answers — earn a week free</h2>
${table(["When (UTC)", "Name", "Phone", "Issues managing their career", "Issues with LinkedIn / Indeed etc.", "One thing Trainee should do"], survey, ["created_at", "name", "phone", "q_career_issues", "q_platform_issues", "q_one_thing"])}
<p class="note">Owner-only page. Keep the admin key private — anyone with it can read these lists.</p>
</body></html>`;

    return respond(html, 200, "text/html; charset=utf-8");
  };
}
