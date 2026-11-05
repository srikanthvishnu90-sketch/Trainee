// Trainee landing page — waitlist survey capture (PUBLIC endpoint). Served by ./index.ts.
//
// The survey page (trainee-six.vercel.app/survey, source site/survey.html)
// is offered right after a waitlist signup ("Earn another week free of
// Trainee") and POSTs JSON here:
//   { name, phone, q1, q2, q3, source }
// Rows land in public.site_waitlist_survey, which has RLS enabled and NO
// public policies — this function writes with the service role, and the
// only read path is the key-gated site-admin function.
//
// Abuse guard (review of #487): a survey is accepted only for a phone that is
// on site_waitlist (normalised to the E.164 form the signup page stores), and
// at most once per phone (403 not on the waitlist, 409 already answered). The
// once-per-phone check is a read before the insert, not a unique constraint, so
// two requests racing for one phone can both land; nothing else is decided here.
// `source` is kept as a path only: no query string, which could carry personal data.
//
// verify_jwt is OFF on purpose: this is a public capture endpoint and the
// page ships no credentials.

export interface SurveyDeps {
  env: (k: string) => string | undefined;
  fetchFn: typeof fetch;
}

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

// The signup page stores `cc + digits` (site/index.html: "+1" numbers have a leading 1 stripped and are 10 digits).
// The same number typed into the survey's own field ("(312) 555-0123", "+1 312 555 0123") maps to that form.
export function waitlistPhone(raw: string): string {
  const s = raw.trim();
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (s.startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  return "+" + d;
}

export function sourcePath(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).split(/[?#]/)[0];
  try {
    return new URL(s).pathname.slice(0, 200);
  } catch {
    return s.slice(0, 200);
  }
}

export function createSurveyHandler(deps: SurveyDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (body == null || typeof body !== "object") return json({ error: "invalid json" }, 400);

    const name = field(body, "name", 200);
    const phone = waitlistPhone(field(body, "phone", 32));
    const q1 = field(body, "q1", 4000);
    const q2 = field(body, "q2", 4000);
    const q3 = field(body, "q3", 4000);
    if (!name || !phone) {
      return json({ error: "name and phone are required" }, 400);
    }
    if (!q1 || !q2 || !q3) {
      return json({ error: "all three answers are required" }, 400);
    }

    const supabaseUrl = deps.env("SUPABASE_URL")!;
    const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const byPhone = `select=id&phone=eq.${encodeURIComponent(phone)}&limit=1`;

    const [wRes, sRes] = await Promise.all([
      deps.fetchFn(`${supabaseUrl}/rest/v1/site_waitlist?${byPhone}`, { headers: auth }),
      deps.fetchFn(`${supabaseUrl}/rest/v1/site_waitlist_survey?${byPhone}`, { headers: auth }),
    ]);
    if (!wRes.ok || !sRes.ok) {
      console.error("site-survey lookup failed", wRes.status, sRes.status);
      return json({ error: "could not save answers" }, 500);
    }
    const onWaitlist = await wRes.json();
    const answered = await sRes.json();
    if (!Array.isArray(onWaitlist) || onWaitlist.length === 0) {
      return json({ error: "not on the waitlist" }, 403);
    }
    if (!Array.isArray(answered) || answered.length > 0) {
      return json({ error: "already answered" }, 409);
    }

    const res = await deps.fetchFn(`${supabaseUrl}/rest/v1/site_waitlist_survey`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        name,
        phone,
        q_career_issues: q1,
        q_platform_issues: q2,
        q_one_thing: q3,
        source: sourcePath(body.source),
      }),
    });

    if (!res.ok) {
      console.error("site-survey insert failed", res.status, await res.text());
      return json({ error: "could not save answers" }, 500);
    }
    return json({ ok: true });
  };
}
