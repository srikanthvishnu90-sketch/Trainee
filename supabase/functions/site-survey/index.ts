// Trainee landing page — waitlist survey capture (PUBLIC endpoint).
//
// The survey page (trainee-six.vercel.app/survey, source site/survey.html)
// is offered right after a waitlist signup ("Earn another week free of
// Trainee") and POSTs JSON here:
//   { name, phone, q1, q2, q3, source }
// Rows land in public.site_waitlist_survey, which has RLS enabled and NO
// public policies — this function writes with the service role, and the
// only read path is the key-gated site-admin function.
//
// verify_jwt is OFF on purpose: this is a public capture endpoint and the
// page ships no credentials.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function field(body: Record<string, unknown>, key: string, max: number): string {
  const v = body[key];
  return v == null ? "" : String(v).trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const name = field(body, "name", 200);
  const phone = field(body, "phone", 32);
  const q1 = field(body, "q1", 4000);
  const q2 = field(body, "q2", 4000);
  const q3 = field(body, "q3", 4000);
  if (!name || !phone) {
    return json({ error: "name and phone are required" }, 400);
  }
  if (!q1 || !q2 || !q3) {
    return json({ error: "all three answers are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const res = await fetch(`${supabaseUrl}/rest/v1/site_waitlist_survey`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      name,
      phone,
      q_career_issues: q1,
      q_platform_issues: q2,
      q_one_thing: q3,
      source: body.source != null ? String(body.source).slice(0, 2000) : null,
    }),
  });

  if (!res.ok) {
    console.error("site-survey insert failed", res.status, await res.text());
    return json({ error: "could not save answers" }, 500);
  }
  return json({ ok: true });
});
