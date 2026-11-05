// Trainee landing page — owner-only waitlist viewer (KEY-GATED endpoint).
//
// GET with ?key=<SITE_ADMIN_KEY> (or an x-admin-key header) renders one
// HTML page listing, newest first:
//   - site_waitlist signups: when, name, phone, source page
//   - site_waitlist_survey answers: when, name, phone, the 3 answers
// If SITE_ADMIN_KEY is not set on the project the function returns 503 —
// it never serves the lists without a key. Reads use the service role;
// both tables have RLS on with no public policies.
//
// verify_jwt is OFF: the key is the credential, checked on every request.

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

Deno.serve(async (req) => {
  const adminKey = Deno.env.get("SITE_ADMIN_KEY");
  if (!adminKey) {
    return new Response("admin not configured", { status: 503 });
  }
  const url = new URL(req.url);
  const given = url.searchParams.get("key") ?? req.headers.get("x-admin-key");
  if (given !== adminKey) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };

  const [wRes, sRes] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/site_waitlist?select=name,phone,source,created_at&order=created_at.desc&limit=1000`,
      { headers },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/site_waitlist_survey?select=name,phone,q_career_issues,q_platform_issues,q_one_thing,created_at&order=created_at.desc&limit=1000`,
      { headers },
    ),
  ]);
  if (!wRes.ok || !sRes.ok) {
    return new Response("could not read lists", { status: 500 });
  }
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
<p class="note">Owner-only page. Keep this link private — anyone with it can read these lists.</p>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
